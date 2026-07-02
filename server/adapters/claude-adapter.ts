/**
 * Claude Code adapter.
 *
 * Claude Code writes structured JSONL files to:
 *   ~/.claude/projects/<cwd-hash>/<session-id>.jsonl
 *
 * Each line is a JSON object with a "type" field: user, assistant, attachment, etc.
 * Assistant messages contain content blocks (text, tool_use, thinking) and usage.
 *
 * We tail these files with fs.watch + readline to emit structured events.
 * The challenge: Claude doesn't write the session ID until the first message,
 * so we discover the session file by watching the project directory.
 */

import { watch, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import { createReadStream } from 'fs'
import { BaseAdapter } from './types.js'
import type { AgentEvent } from '../../src/shared/protocol.js'

const CLAUDE_DIR = join(process.env.HOME || '/tmp', '.claude', 'projects')

/** Convert a cwd path to the Claude projects hash (slashes → dashes) */
function cwdToHash(cwd: string): string {
  // Claude uses the absolute path with / replaced by - and : stripped
  // e.g. /Users/craigporter/agent-multiplexer → -Users-craigporter-agent-multiplexer
  return cwd.replace(/\//g, '-').replace(/:/g, '')
}

export class ClaudeAdapter extends BaseAdapter {
  private cwd: string
  private projectDir: string
  private sessionFile: string | null = null
  private watcher: ReturnType<typeof watch> | null = null
  private dirWatcher: ReturnType<typeof watch> | null = null
  private lastLineCount = 0
  private pollInterval: NodeJS.Timeout | null = null
  private pendingToolCalls = new Map<string, { name: string; input: unknown }>()

  constructor(cwd: string) {
    super()
    this.cwd = cwd
    this.projectDir = join(CLAUDE_DIR, cwdToHash(cwd))
  }

  start(): void {
    this.activity.active = true

    // Try to find an existing session file immediately
    this.discoverSessionFile()

    // Watch the project directory for new JSONL files (new session)
    if (existsSync(this.projectDir)) {
      this.dirWatcher = watch(this.projectDir, (eventType, filename) => {
        if (filename?.endsWith('.jsonl') && !this.sessionFile) {
          this.discoverSessionFile()
        }
      })
    }

    // Also poll every 2s as a fallback — fs.watch can be unreliable
    this.pollInterval = setInterval(() => {
      if (this.stopped) return
      if (!this.sessionFile) {
        this.discoverSessionFile()
      }
    }, 2000)
  }

  stop(): void {
    this.stopped = true
    this.activity.active = false
    this.watcher?.close()
    this.dirWatcher?.close()
    if (this.pollInterval) clearInterval(this.pollInterval)
  }

  /** Find the most recent .jsonl file in the project directory */
  private discoverSessionFile(): void {
    if (!existsSync(this.projectDir)) return

    try {
      const files = readdirSync(this.projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: join(this.projectDir, f),
          mtime: statSync(join(this.projectDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)

      // Pick the most recently modified file that isn't a subagent file
      const main = files.find(f => !f.path.includes('/subagents/'))
      if (main) {
        this.setSessionFile(main.path)
      }
    } catch {
      // Directory might not exist yet
    }
  }

  private setSessionFile(path: string): void {
    if (this.sessionFile === path) return
    this.sessionFile = path
    this.lastLineCount = 0

    // Start tailing this file
    this.tailFile()

    // Watch for appends
    this.watcher = watch(path, () => {
      if (!this.stopped) this.tailFile()
    })
  }

  /** Read new lines from the session file since last read */
  private async tailFile(): Promise<void> {
    if (!this.sessionFile || !existsSync(this.sessionFile)) return

    try {
      const rl = createInterface({
        input: createReadStream(this.sessionFile, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      })

      let lineNum = 0
      for await (const line of rl) {
        lineNum++
        if (lineNum <= this.lastLineCount) continue
        if (line.trim()) {
          this.parseLine(line)
        }
      }
      this.lastLineCount = lineNum
    } catch {
      // File might be mid-write
    }
  }

  private parseLine(line: string): void {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }

    const type = obj.type
    const timestamp = obj.timestamp || new Date().toISOString()

    switch (type) {
      case 'user': {
        // User messages can be either a new prompt (turn-start) or contain
        // tool_result blocks. Check for tool_result content first.
        const message = obj.message
        const content: any[] = message?.content || []
        const hasToolResult = content.some(
          (b: any) => b?.type === 'tool_result'
        )

        if (hasToolResult) {
          // Emit tool-result events for each block
          for (const block of content) {
            if (block?.type === 'tool_result' && block.tool_use_id) {
              this.emit({
                id: `result-${block.tool_use_id}`,
                kind: 'tool-result',
                timestamp,
                toolCallId: block.tool_use_id,
                detail: this.summarizeToolResult(block.content),
              })
            }
          }
        } else {
          // A real user message starts a new turn
          this.emit({
            id: obj.uuid || `${timestamp}-turn`,
            kind: 'turn-start',
            timestamp,
          })
        }
        break
      }

      case 'assistant': {
        const message = obj.message
        if (!message) break

        const usage = message.usage
        const content: any[] = message.content || []

        for (const block of content) {
          if (!block || typeof block !== 'object') continue

          if (block.type === 'thinking') {
            this.emit({
              id: obj.uuid || `${timestamp}-think`,
              kind: 'thinking',
              timestamp,
              preview: (block.thinking || '').slice(0, 120),
            })
          } else if (block.type === 'text') {
            this.emit({
              id: obj.uuid || `${timestamp}-text`,
              kind: 'text',
              timestamp,
              preview: (block.text || '').slice(0, 120),
            })
          } else if (block.type === 'tool_use') {
            this.pendingToolCalls.set(block.id, { name: block.name, input: block.input })
            this.emit({
              id: block.id || `${timestamp}-tool`,
              kind: 'tool-call',
              timestamp,
              toolName: block.name,
              toolCallId: block.id,
              detail: this.summarizeToolInput(block.name, block.input),
            })
          }
        }

        if (usage) {
          this.emit({
            id: `${obj.uuid || timestamp}-usage`,
            kind: 'usage',
            timestamp,
            usage: {
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cacheReadTokens: usage.cache_read_input_tokens || 0,
            },
          })
        }

        // Emit turn-end after the assistant message
        this.emit({
          id: `${obj.uuid || timestamp}-turnend`,
          kind: 'turn-end',
          timestamp,
        })
        break
      }
    }
  }

  private summarizeToolInput(name: string, input: any): string {
    if (!input || typeof input !== 'object') return ''
    if (name === 'Read' && input.file_path) return input.file_path as string
    if (name === 'Bash' && input.command) return (input.command as string).slice(0, 80)
    if (name === 'Write' && input.file_path) return input.file_path as string
    if (name === 'Edit' && input.file_path) return input.file_path as string
    if (name === 'Glob' && input.pattern) return input.pattern as string
    if (name === 'Grep' && input.pattern) return input.pattern as string
    const firstVal = Object.values(input)[0]
    return firstVal ? String(firstVal).slice(0, 80) : ''
  }

  private summarizeToolResult(content: any): string {
    if (typeof content === 'string') return content.slice(0, 80)
    if (Array.isArray(content)) {
      const text = content.find((c: any) => c?.type === 'text')
      return text ? (text.text as string).slice(0, 80) : ''
    }
    return ''
  }
}
