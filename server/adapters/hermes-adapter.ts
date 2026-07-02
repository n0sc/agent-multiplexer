/**
 * Hermes adapter.
 *
 * Hermes writes structured session data to ~/.hermes/state.db (SQLite):
 *   - sessions table: aggregate token counts, tool_call_count, message_count
 *   - messages table: per-message role, tool_name, tool_calls, reasoning, token_count
 *
 * We poll the DB for new messages since last check, since SQLite doesn't have
 * a built-in change-notification mechanism. Poll interval is 2s — light enough
 * to feel real-time without taxing the DB.
 *
 * The challenge: identifying which Hermes session corresponds to this PTY session.
 * We match by cwd — Hermes sessions store their working directory, and the PTY
 * was spawned with the same cwd. If multiple Hermes sessions share a cwd, we
 * pick the most recently started one.
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { BaseAdapter } from './types.js'
import type { AgentEvent } from '../../src/shared/protocol.js'

const HERMES_DB = join(process.env.HOME || '/tmp', '.hermes', 'state.db')
const POLL_INTERVAL_MS = 2000

export class HermesAdapter extends BaseAdapter {
  private cwd: string
  private db: DatabaseSync | null = null
  private sessionId: string | null = null
  private lastMessageId = 0
  private pollTimer: NodeJS.Timeout | null = null

  constructor(cwd: string) {
    super()
    this.cwd = cwd
  }

  start(): void {
    if (!existsSync(HERMES_DB)) {
      // DB might not exist yet — try again on first poll
      this.activity.active = true
    } else {
      this.connectAndDiscover()
    }

    this.pollTimer = setInterval(() => {
      if (this.stopped) return
      if (!this.db) {
        this.connectAndDiscover()
      } else if (this.sessionId) {
        this.pollNewMessages()
      }
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    this.activity.active = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    try { this.db?.close() } catch { /* already closed */ }
  }

  private connectAndDiscover(): void {
    if (!existsSync(HERMES_DB)) return

    try {
      this.db = new DatabaseSync(HERMES_DB, { readOnly: true })
      this.activity.active = true
      this.discoverSession()
    } catch (err) {
      // DB might be mid-write
    }
  }

  /** Find the most recent Hermes session matching our cwd */
  private discoverSession(): void {
    if (!this.db) return

    try {
      const stmt = this.db.prepare(
        `SELECT id, started_at FROM sessions
         WHERE cwd = ?
         ORDER BY started_at DESC LIMIT 1`
      )
      const row = stmt.get(this.cwd) as { id: string; started_at: number } | undefined

      if (row) {
        this.sessionId = row.id
        // Backfill: read all existing messages to populate activity counts
        this.backfillActivity()
      }
    } catch {
      // Table might not exist
    }
  }

  /** On first connect, read existing message counts to seed the activity */
  private backfillActivity(): void {
    if (!this.db || !this.sessionId) return

    try {
      // Get session-level aggregate counts
      const sessionStmt = this.db.prepare(
        `SELECT tool_call_count, input_tokens, output_tokens, cache_read_tokens
         FROM sessions WHERE id = ?`
      )
      const session = sessionStmt.get(this.sessionId) as any
      if (session) {
        this.activity.toolCallCount = session.tool_call_count || 0
        this.activity.inputTokens = session.input_tokens || 0
        this.activity.outputTokens = session.output_tokens || 0
        this.activity.cacheReadTokens = session.cache_read_tokens || 0
      }

      // Count turns (user messages) and get last tool name
      const msgs = this.db.prepare(
        `SELECT id, role, tool_name FROM messages
         WHERE session_id = ? ORDER BY id ASC`
      )
      let turnCount = 0
      let lastToolName: string | null = null
      for (const msg of msgs.iterate(this.sessionId) as IterableIterator<any>) {
        this.lastMessageId = Math.max(this.lastMessageId, msg.id)
        if (msg.role === 'user') turnCount++
        if (msg.tool_name) lastToolName = msg.tool_name
      }
      this.activity.turnCount = turnCount
      this.activity.lastToolName = lastToolName
    } catch {
      // Schema mismatch or DB locked
    }
  }

  /** Poll for messages newer than lastMessageId */
  private pollNewMessages(): void {
    if (!this.db || !this.sessionId) return

    try {
      const stmt = this.db.prepare(
        `SELECT id, role, tool_name, tool_calls, content, reasoning, token_count,
                finish_reason, timestamp
         FROM messages
         WHERE session_id = ? AND id > ?
         ORDER BY id ASC`
      )

      for (const msg of stmt.iterate(this.sessionId, this.lastMessageId) as IterableIterator<any>) {
        this.lastMessageId = msg.id
        this.processMessage(msg)
      }
    } catch {
      // DB locked or schema issue — silently retry next poll
    }
  }

  private processMessage(msg: any): void {
    const timestamp = new Date((msg.timestamp || 0) * 1000).toISOString()

    if (msg.role === 'user') {
      this.emit({
        id: `hermes-${msg.id}-turn`,
        kind: 'turn-start',
        timestamp,
      })
    }

    if (msg.role === 'assistant') {
      // Check for reasoning/thinking
      if (msg.reasoning_content || msg.reasoning) {
        this.emit({
          id: `hermes-${msg.id}-think`,
          kind: 'thinking',
          timestamp,
          preview: (msg.reasoning_content || msg.reasoning || '').slice(0, 120),
        })
      }

      // Emit text content preview
      if (msg.content) {
        this.emit({
          id: `hermes-${msg.id}-text`,
          kind: 'text',
          timestamp,
          preview: (msg.content as string).slice(0, 120),
        })
      }

      // Token usage
      if (msg.token_count) {
        this.emit({
          id: `hermes-${msg.id}-usage`,
          kind: 'usage',
          timestamp,
          usage: {
            outputTokens: msg.token_count,
          },
        })
      }

      this.emit({
        id: `hermes-${msg.id}-turnend`,
        kind: 'turn-end',
        timestamp,
      })
    }

    // Tool calls (stored in tool_calls column as JSON)
    if (msg.tool_calls) {
      try {
        const calls = typeof msg.tool_calls === 'string'
          ? JSON.parse(msg.tool_calls)
          : msg.tool_calls
        const callList = Array.isArray(calls) ? calls : [calls]

        for (const call of callList) {
          const fn = call.function || call
          const name = fn.name || msg.tool_name || 'unknown'
          const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
          const callId = call.call_id || call.id || `hermes-${msg.id}-tool`

          this.emit({
            id: callId,
            kind: 'tool-call',
            timestamp,
            toolName: name,
            toolCallId: callId,
            detail: this.summarizeInput(name, args),
          })
        }
      } catch {
        // Malformed tool_calls
      }
    }

    // Direct tool result (role === 'tool')
    if (msg.role === 'tool') {
      this.emit({
        id: `hermes-${msg.id}-result`,
        kind: 'tool-result',
        timestamp,
        toolName: msg.tool_name,
        toolCallId: msg.tool_call_id,
        detail: (msg.content || '').slice(0, 80),
      })
    }
  }

  private summarizeInput(name: string, args: any): string {
    if (!args || typeof args !== 'object') return ''
    if (args.command) return String(args.command).slice(0, 80)
    if (args.path) return String(args.path)
    if (args.pattern) return String(args.pattern)
    if (args.query) return String(args.query).slice(0, 80)
    const firstVal = Object.values(args)[0]
    return firstVal ? String(firstVal).slice(0, 80) : ''
  }
}
