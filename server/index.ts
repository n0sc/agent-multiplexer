/**
 * Backend server for Agent Multiplexer.
 *
 * Manages PTY processes (Claude, Hermes, shells), tracks their status by
 * pattern-matching output, and streams everything to connected React clients
 * over WebSocket.
 *
 * Sessions survive server restarts via a JSON state file. Archived sessions
 * keep their metadata but are hidden from the active list.
 */

import { WebSocketServer, WebSocket } from 'ws'
import * as pty from 'node-pty'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import type {
  ClientMessage,
  ServerMessage,
  SessionMeta,
  SessionStatus,
  AgentPreset,
  TranscribeMessage,
  Workspace,
  DirEntry,
  AppSettings,
  RefineMessage,
  DelegateMessage,
  StructuredActivity,
} from '../src/shared/protocol.js'
import { AGENT_PRESETS } from '../src/shared/protocol.js'
import { speechManager } from './speech-manager.js'
import { createServer as createHttpsServer } from 'https'
import { AgentAdapter } from './adapters/types.js'
import { ClaudeAdapter } from './adapters/claude-adapter.js'
import { HermesAdapter } from './adapters/hermes-adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.AGENT_MUX_PORT || '3461', 10)
const STATE_DIR = join(process.env.HOME || '/tmp', '.agent-multiplexer')
const STATE_FILE = join(STATE_DIR, 'sessions.json')
const WORKSPACE_FILE = join(STATE_DIR, 'workspaces.json')
const SETTINGS_FILE = join(STATE_DIR, 'settings.json')

// ── State Persistence ───────────────────────────────────────────

function loadState(): SessionMeta[] {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
    }
  } catch (e) {
    console.error('[agent-mux] Failed to load state:', e)
  }
  return []
}

function saveState(sessions: SessionMeta[]) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(sessions, null, 2))
  } catch (e) {
    console.error('[agent-mux] Failed to save state:', e)
  }
}

// ── Workspace Persistence ───────────────────────────────────────

function loadWorkspaces(): Workspace[] {
  try {
    if (existsSync(WORKSPACE_FILE)) {
      return JSON.parse(readFileSync(WORKSPACE_FILE, 'utf-8'))
    }
  } catch (e) {
    console.error('[agent-mux] Failed to load workspaces:', e)
  }
  return []
}

function saveWorkspaces(workspaces: Workspace[]) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(WORKSPACE_FILE, JSON.stringify(workspaces, null, 2))
  } catch (e) {
    console.error('[agent-mux] Failed to save workspaces:', e)
  }
}

// ── Settings Persistence ────────────────────────────────────────

const DEFAULT_SETTINGS: AppSettings = {
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  refineModel: '',  // empty = auto-pick
}

function loadSettings(): AppSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) }
    }
  } catch (e) {
    console.error('[agent-mux] Failed to load settings:', e)
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings: AppSettings) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
  } catch (e) {
    console.error('[agent-mux] Failed to save settings:', e)
  }
}

// ── Session Manager ─────────────────────────────────────────────

interface ManagedSession {
  meta: SessionMeta
  pty: pty.IPty | null  // null after process exits or server restart
  preset: AgentPreset
  recentOutput: string
  statusTimer: NodeJS.Timeout | null
  activeViewers: Set<WebSocket>
  adapter: AgentAdapter | null  // structured event source (null for shells)
}

class SessionManager {
  private sessions = new Map<string, ManagedSession>()
  private clients = new Set<WebSocket>()
  private workspaces: Workspace[] = loadWorkspaces()
  private settings: AppSettings = loadSettings()

  constructor() {
    // Restore sessions from disk on startup
    const saved = loadState()
    for (const meta of saved) {
      // The PTY is gone after restart, but we keep the metadata
      // Mark as 'detached' so the user knows it's not live
      const presetKey = meta.agentType
      const preset = AGENT_PRESETS[presetKey] || AGENT_PRESETS.shell
      this.sessions.set(meta.id, {
        meta: { ...meta, status: meta.archived ? meta.status : 'detached' },
        pty: null,
        preset,
        recentOutput: meta.recentOutput || '',  // restore scrollback from disk
        statusTimer: null,
        activeViewers: new Set(),
        adapter: null,  // no live adapter after restart (process is gone)
      })
    }
    if (saved.length > 0) {
      console.log(`[agent-mux] Restored ${saved.length} sessions from disk (${saved.filter(s => !s.archived).length} active, ${saved.filter(s => s.archived).length} archived)`)
    }
  }

  // ── Client Management ──────────────────────────────────────────

  addClient(ws: WebSocket) {
    this.clients.add(ws)
    this.sendTo(ws, {
      type: 'sessions',
      sessions: this.getAllMeta(),
    })
    this.sendTo(ws, {
      type: 'workspaces',
      workspaces: this.workspaces,
    })
    this.sendTo(ws, {
      type: 'settings',
      settings: {
        ...this.settings,
        openrouterApiKey: this.settings.openrouterApiKey ? '•••configured' : '',
      },
    })

    // Replay scrollback for every live session so the terminal isn't blank
    for (const [sessionId, session] of this.sessions) {
      if (session.recentOutput.length > 0) {
        this.sendTo(ws, {
          type: 'output',
          sessionId,
          data: session.recentOutput,
        })
      }
    }
  }

  removeClient(ws: WebSocket) {
    this.clients.delete(ws)
    for (const session of this.sessions.values()) {
      session.activeViewers.delete(ws)
    }
    // Save state when client disconnects so scrollback survives
    this.persistState()
  }

  // ── Session Lifecycle ──────────────────────────────────────────

  createSession(opts: {
    name: string
    command: string
    args?: string[]
    cwd?: string
    agentType?: string
    instructions?: string
  }): SessionMeta {
    const id = randomUUID().slice(0, 8)
    const presetKey = opts.agentType || this.guessAgentType(opts.command)
    const preset = AGENT_PRESETS[presetKey] || AGENT_PRESETS.shell

    const cwd = (opts.cwd || process.env.HOME || '/tmp').replace(/^~(?=\W|$|\/)/, process.env.HOME || '')

    // Resolve shell: if the frontend sent 'bash' (its browser-side fallback),
    // use the server's real login shell instead so .zshrc / .bashrc is sourced.
    const resolvedShell = opts.command === 'bash' && process.env.SHELL
      ? process.env.SHELL
      : opts.command

    // For bare shell invocations, spawn as a login shell so the user's
    // profile (.zprofile/.zshrc, .bash_profile/.bashrc) is fully sourced.
    // Convention: argv[0] prefixed with '-' signals a login shell to zsh/bash.
    let command = resolvedShell
    let args = opts.args || []
    if (opts.command === 'bash' && !opts.args) {
      command = resolvedShell
      args = ['-l']  // -l = login shell
    }

    // ── Inject LLM instructions based on agent type ──────────────
    const instructions = opts.instructions?.trim()
    if (instructions) {
      if (presetKey === 'claude') {
        // Claude: --append-system-prompt adds to the default system prompt
        args = [...args, '--append-system-prompt', instructions]
      } else if (presetKey === 'hermes') {
        // Hermes auto-loads .hermes.md from cwd on startup.
        // Write a section with workspace instructions (idempotent).
        try {
          const hermesMdPath = join(cwd, '.hermes.md')
          const header = '<!-- agent-multiplexer workspace instructions -->\n## Workspace Instructions\n\n' + instructions + '\n'
          if (existsSync(hermesMdPath)) {
            const existing = readFileSync(hermesMdPath, 'utf-8')
            // Replace existing section or prepend new one
            if (existing.includes('<!-- agent-multiplexer workspace instructions -->')) {
              const updated = existing.replace(
                /<!-- agent-multiplexer workspace instructions -->[\s\S]*?(?=\n## |$)/,
                header.trim()
              )
              writeFileSync(hermesMdPath, updated)
            } else {
              writeFileSync(hermesMdPath, header + '\n' + existing)
            }
          } else {
            writeFileSync(hermesMdPath, header)
          }
        } catch (e) {
          console.error('[agent-mux] Failed to write .hermes.md:', e)
        }
      }
      // shell: no instruction injection (it's just a terminal)
    }

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>,
    })

    const meta: SessionMeta = {
      id,
      name: opts.name,
      status: 'idle',
      agentType: preset.agentType,
      cwd,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      hasUnreadOutput: false,
      summary: 'Starting...',
      accentColor: preset.accentColor,
      archived: false,
    }

    const session: ManagedSession = {
      meta,
      pty: ptyProcess,
      preset,
      recentOutput: '',
      statusTimer: null,
      activeViewers: new Set(),
      adapter: null,
    }

    // ── Start structured adapter for known agent types ────────────
    // The adapter tails the agent's persistence (JSONL/SQLite) alongside
    // the PTY, providing real tool-call counts, token usage, and thinking
    // state instead of regex-guessing from terminal output.
    const adapter = this.createAdapter(presetKey, cwd)
    if (adapter) {
      session.adapter = adapter
      adapter.onEvent((event) => {
        this.broadcast({
          type: 'agent-event',
          sessionId: id,
          event,
        })
        // Update structuredActivity on session meta
        const act = adapter.getActivity()
        session.meta.structuredActivity = act
        // If we have structured data, use it to override status detection
        if (event.kind === 'tool-call') {
          // A tool call means the agent is actively working
          this.updateStatus(id, 'working', `${event.toolName}: ${event.detail || ''}`)
        } else if (event.kind === 'turn-end') {
          // Turn completed — agent is likely idle/needs-input now
          this.updateStatus(id, 'idle', session.meta.summary)
        }
      })
      adapter.start()
    }

    this.sessions.set(id, session)
    this.persistState()

    ptyProcess.onData((data) => {
      this.handleOutput(id, data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      const status: SessionStatus = exitCode === 0 ? 'completed' : 'failed'
      this.updateStatus(id, status, exitCode === 0 ? 'Completed' : `Exited (${exitCode})`)
      session.pty = null
      this.broadcast({
        type: 'session-closed',
        sessionId: id,
        exitCode,
      })
      this.persistState()
    })

    this.broadcast({
      type: 'session-created',
      session: meta,
    })

    return meta
  }

  sendInput(sessionId: string, data: string) {
    const session = this.sessions.get(sessionId)
    if (session?.pty) {
      session.pty.write(data)
      session.meta.lastActivity = new Date().toISOString()
      if (session.meta.status === 'needs-input') {
        this.updateStatus(sessionId, 'working', session.meta.summary)
      }
    }
  }

  resizeSession(sessionId: string, cols: number, rows: number) {
    const session = this.sessions.get(sessionId)
    if (session?.pty) {
      session.pty.resize(cols, rows)
    }
  }

  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (session?.pty) {
      session.pty.kill()
      session.pty = null
      this.updateStatus(sessionId, 'stopped', 'Stopped by user')
      this.persistState()
    }
    session?.adapter?.stop()
    session && (session.adapter = null)
  }

  archiveSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // Kill the PTY if alive — we keep the metadata for history
    if (session.pty) {
      session.pty.kill()
      session.pty = null
    }

    // Stop the structured adapter
    session.adapter?.stop()
    session.adapter = null

    session.meta.archived = true
    session.meta.status = 'stopped'
    session.meta.summary = 'Archived'
    session.meta.hasUnreadOutput = false
    this.persistState()
    this.broadcastSessionList()
  }

  unarchiveSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.meta.archived = false
    // Can't revive the PTY, so mark as detached
    session.meta.status = session.pty ? session.meta.status : 'detached'
    session.meta.summary = 'Restored (reattach to continue)'
    this.persistState()
    this.broadcastSessionList()
  }

  deleteSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // Kill the PTY if still alive
    if (session.pty) {
      session.pty.kill()
      session.pty = null
    }

    // Stop the structured adapter
    session.adapter?.stop()
    session.adapter = null

    this.sessions.delete(sessionId)
    this.persistState()
    this.broadcastSessionList()
  }

  // ── Workspace CRUD ─────────────────────────────────────────────

  createWorkspace(ws: {
    name: string
    agentType: string
    cwd: string
    args?: string[]
    icon?: string
    instructions?: string
  }): Workspace {
    const workspace: Workspace = {
      id: randomUUID().slice(0, 8),
      name: ws.name,
      agentType: ws.agentType,
      cwd: ws.cwd,
      ...(ws.args?.length ? { args: ws.args } : {}),
      ...(ws.icon ? { icon: ws.icon } : {}),
      ...(ws.instructions?.trim() ? { instructions: ws.instructions.trim() } : {}),
    }
    this.workspaces.push(workspace)
    saveWorkspaces(this.workspaces)
    this.broadcastWorkspaces()
    return workspace
  }

  updateWorkspace(ws: {
    id: string
    name?: string
    agentType?: string
    cwd?: string
    args?: string[]
    icon?: string
    instructions?: string
  }): void {
    const idx = this.workspaces.findIndex(w => w.id === ws.id)
    if (idx === -1) return
    const existing = this.workspaces[idx]
    this.workspaces[idx] = {
      ...existing,
      ...(ws.name !== undefined ? { name: ws.name } : {}),
      ...(ws.agentType !== undefined ? { agentType: ws.agentType } : {}),
      ...(ws.cwd !== undefined ? { cwd: ws.cwd } : {}),
      ...(ws.args !== undefined ? { args: ws.args } : {}),
      ...(ws.icon !== undefined ? { icon: ws.icon } : {}),
      ...(ws.instructions !== undefined ? { instructions: ws.instructions.trim() || undefined } : {}),
    }
    saveWorkspaces(this.workspaces)
    this.broadcastWorkspaces()
  }

  deleteWorkspace(id: string): void {
    this.workspaces = this.workspaces.filter(w => w.id !== id)
    saveWorkspaces(this.workspaces)
    this.broadcastWorkspaces()
  }

  archiveWorkspace(id: string): void {
    const ws = this.workspaces.find(w => w.id === id)
    if (!ws) return
    ws.archived = true
    saveWorkspaces(this.workspaces)
    this.broadcastWorkspaces()
  }

  unarchiveWorkspace(id: string): void {
    const ws = this.workspaces.find(w => w.id === id)
    if (!ws) return
    ws.archived = false
    saveWorkspaces(this.workspaces)
    this.broadcastWorkspaces()
  }

  private broadcastWorkspaces() {
    this.broadcast({
      type: 'workspaces',
      workspaces: this.workspaces,
    })
  }

  // ── Settings ───────────────────────────────────────────────────

  updateSettings(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch }
    saveSettings(this.settings)
    this.broadcastSettings()
  }

  private broadcastSettings() {
    this.broadcast({
      type: 'settings',
      settings: {
        ...this.settings,
        openrouterApiKey: this.settings.openrouterApiKey ? '•••configured' : '',
      },
    })
  }

  // ── Inter-Agent Delegation ─────────────────────────────────────

  private async handleDelegate(ws: WebSocket, msg: DelegateMessage) {
    const { fromSessionId, toSessionId, task } = msg
    const fromSession = this.sessions.get(fromSessionId)
    const toSession = this.sessions.get(toSessionId)

    if (!fromSession || !toSession) {
      this.sendTo(ws, {
        type: 'delegation-result',
        delegationId: '',
        fromSessionId,
        toSessionId,
        result: '',
        error: 'Source or target session not found',
      })
      return
    }

    if (!toSession.pty) {
      this.sendTo(ws, {
        type: 'delegation-result',
        delegationId: '',
        fromSessionId,
        toSessionId,
        result: '',
        error: 'Target session has no live PTY',
      })
      return
    }

    const delegationId = `del-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    const fromName = fromSession.meta.name
    const toName = toSession.meta.name

    console.log(`[delegate] ${fromName} → ${toName}: ${task.slice(0, 60)}`)

    // Emit thread-sent event on the source session
    this.broadcast({
      type: 'agent-event',
      sessionId: fromSessionId,
      event: {
        id: `${delegationId}-sent`,
        kind: 'thread-sent',
        timestamp: now,
        threadPeerName: toName,
        threadId: delegationId,
        preview: task.slice(0, 120),
      },
    })

    // Emit thread-received event on the target session (it received a task)
    this.broadcast({
      type: 'agent-event',
      sessionId: toSessionId,
      event: {
        id: `${delegationId}-recv`,
        kind: 'thread-sent',
        timestamp: now,
        threadPeerName: fromName,
        threadId: delegationId,
        preview: task.slice(0, 120),
      },
    })

    // Inject the task into the target agent's PTY
    toSession.pty.write(task + '\r')

    // If the target has an adapter, watch for the next turn-end to capture the result.
    // If no adapter (shell), we can't detect completion — return immediately with a note.
    if (!toSession.adapter) {
      console.log(`[delegate] Target "${toName}" has no adapter — cannot detect completion`)
      // For shells, wait 5s and grab recent output as a best-effort result
      setTimeout(() => {
        const output = toSession.recentOutput.slice(-500)
        this.completeDelegation(fromSessionId, toSessionId, delegationId, fromName, toName, output, 'No structured adapter — captured raw terminal output')
      }, 5000)
      return
    }

    // Watch the adapter for turn-end with a timeout
    let settled = false
    let lastText = ''

    const onEvent = (event: any) => {
      if (settled) return
      // Accumulate the last assistant text
      if (event.kind === 'text') {
        lastText = event.preview || lastText
      }
      // Turn-end means the agent finished its response
      if (event.kind === 'turn-end') {
        settled = true
        cleanup()
        this.completeDelegation(fromSessionId, toSessionId, delegationId, fromName, toName, lastText || '(empty response)')
      }
    }

    // Subscribe to adapter events
    const originalOnEvent = onEvent
    toSession.adapter.onEvent(originalOnEvent)

    // Timeout: if no turn-end in 120s, return what we have
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        cleanup()
        this.completeDelegation(fromSessionId, toSessionId, delegationId, fromName, toName, lastText || '(no response within timeout)', 'Delegation timed out after 120s')
      }
    }, 120000)

    function cleanup() {
      clearTimeout(timeout)
      // Note: onEvent adds to a Set, we can't remove individual callbacks.
      // This is fine — the callback becomes a no-op once settled=true.
    }
  }

  private completeDelegation(
    fromSessionId: string,
    toSessionId: string,
    delegationId: string,
    fromName: string,
    toName: string,
    result: string,
    error?: string,
  ) {
    const now = new Date().toISOString()

    console.log(`[delegate] ${toName} → ${fromName}: ${error ? 'ERROR' : result.slice(0, 60)}`)

    // Emit thread-received on the source session (it gets the result back)
    this.broadcast({
      type: 'agent-event',
      sessionId: fromSessionId,
      event: {
        id: `${delegationId}-result`,
        kind: 'thread-received',
        timestamp: now,
        threadPeerName: toName,
        threadId: delegationId,
        preview: result.slice(0, 120),
      },
    })

    // Inject the result into the source agent's PTY (as context)
    const fromSession = this.sessions.get(fromSessionId)
    if (fromSession?.pty && !error) {
      const injected = `\r[Delegation result from ${toName}]: ${result}\r`
      fromSession.pty.write(injected)
    }

    // Send the structured result message to all clients
    this.broadcast({
      type: 'delegation-result',
      delegationId,
      fromSessionId,
      toSessionId,
      result,
      error,
    })
  }

  // ── LLM-Powered Speech Refinement ──────────────────────────────

  private async handleRefine(ws: WebSocket, msg: RefineMessage) {
    try {
      if (!this.settings.openrouterApiKey || this.settings.openrouterApiKey === '•••configured') {
        this.sendTo(ws, {
          type: 'refine-result',
          requestId: msg.requestId,
          text: '',
          error: 'No OpenRouter API key configured. Open Settings (⚙️) to add one.',
        })
        return
      }

      const model = this.settings.refineModel || 'google/gemini-2.0-flash-exp:free'
      const agentContext = msg.agentType || 'shell'

      const systemPrompt = `You refine rambling speech transcriptions into clear, concise prompts for a ${agentContext} agent terminal.

Rules:
- Output ONLY the refined prompt text, nothing else — no preamble, no explanation
- Preserve all technical details, file paths, and specifics the user mentioned
- Convert conversational filler into direct imperatives ("can you check if..." → "Check if...")
- Keep it natural — don't add words the user didn't intend
- If the text is already clean and concise, return it mostly unchanged
- Fix obvious transcription errors (homophones, missing punctuation)
- If the speech references "this" or "that" ambiguously, keep it — the agent has context`

      const refined = await this.callOpenRouter(model, systemPrompt, msg.text)
      console.log(`[refine] ${msg.text.slice(0, 60)}... → ${refined.slice(0, 60)}...`)

      this.sendTo(ws, {
        type: 'refine-result',
        requestId: msg.requestId,
        text: refined,
      })
    } catch (err: any) {
      console.error('[refine] Error:', err.message)
      this.sendTo(ws, {
        type: 'refine-result',
        requestId: msg.requestId,
        text: '',
        error: err.message,
      })
    }
  }

  private async callOpenRouter(model: string, systemPrompt: string, userText: string): Promise<string> {
    const https = await import('https')

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        max_tokens: 500,
        temperature: 0.3,
      })

      const req = https.request('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.openrouterApiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'HTTP-Referer': 'https://claudebox.tail6183bd.ts.net:3460',
          'X-Title': 'Agent Multiplexer',
        },
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`OpenRouter ${res.statusCode}: ${data.slice(0, 200)}`))
            return
          }
          try {
            const json = JSON.parse(data)
            const content = json.choices?.[0]?.message?.content || ''
            resolve(content.trim())
          } catch (e) {
            reject(new Error('Failed to parse OpenRouter response'))
          }
        })
      })

      req.on('error', reject)
      req.setTimeout(15000, () => {
        req.destroy(new Error('OpenRouter request timed out'))
      })

      req.write(body)
      req.end()
    })
  }

  markViewed(sessionId: string, ws: WebSocket) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.meta.hasUnreadOutput = false
      session.activeViewers.add(ws)
      this.broadcastSessionList()
    }
  }

  // ── Output Handling & Status Detection ─────────────────────────

  private handleOutput(sessionId: string, data: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.meta.lastActivity = new Date().toISOString()

    if (session.activeViewers.size === 0) {
      session.meta.hasUnreadOutput = true
    }

    // Strip OSC sequences that leak as visible garbage in xterm.js.
    // OSC = ESC ] ... BEL (ST)  — terminal color/icon commands.
    const clean = data.replace(/\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g, '')

    this.broadcast({
      type: 'output',
      sessionId,
      data: clean,
    })

    // Accumulate for scrollback replay, but strip blank-screen sequences
    // that make saved output look empty (alternate buffer toggles, screen
    // clears, cursor-only ANSI codes with no visible text).
    const forScrollback = stripBlankScreenSequences(clean)
    if (forScrollback.length > 0) {
      session.recentOutput = (session.recentOutput + forScrollback).slice(-50000)
    }
    this.detectStatus(sessionId, clean.length)
  }

  private detectStatus(sessionId: string, chunkSize = 0) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const { recentOutput, preset, meta } = session

    const lastChunk = recentOutput.slice(-500)

    for (const pattern of preset.needsInputPatterns) {
      if (pattern.test(lastChunk)) {
        this.updateStatus(sessionId, 'needs-input', this.extractSummary(recentOutput))
        return
      }
    }

    for (const pattern of preset.workingPatterns) {
      if (pattern.test(lastChunk)) {
        this.updateStatus(sessionId, 'working', this.extractSummary(recentOutput))
        return
      }
    }

    if (chunkSize > 50 && meta.status === 'idle') {
      this.updateStatus(sessionId, 'working', this.extractSummary(recentOutput))
    }
  }

  private extractSummary(output: string): string {
    const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()
    const lines = clean.split('\n').filter(l => l.trim().length > 0)
    const last = lines[lines.length - 1] || ''
    return last.slice(0, 80)
  }

  private updateStatus(sessionId: string, status: SessionStatus, summary: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const oldStatus = session.meta.status
    session.meta.status = status
    session.meta.summary = summary
    session.meta.lastActivity = new Date().toISOString()

    if (oldStatus !== status) {
      this.broadcast({
        type: 'status-change',
        sessionId,
        status,
        summary,
      })

      if (status === 'needs-input') {
        this.broadcast({
          type: 'alert',
          sessionId,
          message: `"${session.meta.name}" needs your input`,
          level: 'warning',
        })
      }

      this.broadcastSessionList()
      this.persistState()
    }
  }

  // ── Adapter Factory ────────────────────────────────────────────

  private createAdapter(agentType: string, cwd: string): AgentAdapter | null {
    switch (agentType) {
      case 'claude':
        return new ClaudeAdapter(cwd)
      case 'hermes':
        return new HermesAdapter(cwd)
      default:
        return null  // shells and unknown types get no adapter
    }
  }

  // ── Utilities ──────────────────────────────────────────────────

  private guessAgentType(command: string): string {
    if (command.includes('claude')) return 'claude'
    if (command.includes('hermes')) return 'hermes'
    return 'shell'
  }

  private getAllMeta(): SessionMeta[] {
    // Strip recentOutput from broadcast — it's large and sent separately.
    // Include structuredActivity so the sidebar can show tool/token info.
    return Array.from(this.sessions.values()).map(s => {
      const { recentOutput, ...meta } = s.meta
      return meta
    })
  }

  private persistState() {
    // Include recentOutput in the saved meta so scrollback survives restarts
    const metas = Array.from(this.sessions.values()).map(s => ({
      ...s.meta,
      recentOutput: s.recentOutput,
    }))
    saveState(metas)
  }

  private broadcastSessionList() {
    this.broadcast({
      type: 'sessions',
      sessions: this.getAllMeta(),
    })
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  // ── Message Handler ────────────────────────────────────────────

  handleMessage(ws: WebSocket, raw: string) {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      console.error('[agent-mux] Invalid message:', raw.slice(0, 100))
      return
    }

    switch (msg.type) {
      case 'create-session':
        this.createSession(msg)
        break
      case 'input':
        this.sendInput(msg.sessionId, msg.data)
        break
      case 'resize':
        this.resizeSession(msg.sessionId, msg.cols, msg.rows)
        break
      case 'close-session':
        this.closeSession(msg.sessionId)
        break
      case 'archive-session':
        this.archiveSession(msg.sessionId)
        break
      case 'unarchive-session':
        this.unarchiveSession(msg.sessionId)
        break
      case 'delete-session':
        this.deleteSession(msg.sessionId)
        break
      case 'switch-session':
        this.markViewed(msg.sessionId, ws)
        break
      case 'transcribe':
        this.handleTranscription(ws, msg)
        break
      case 'create-workspace':
        this.createWorkspace(msg)
        break
      case 'update-workspace':
        this.updateWorkspace(msg)
        break
      case 'delete-workspace':
        this.deleteWorkspace(msg.id)
        break
      case 'archive-workspace':
        this.archiveWorkspace(msg.id)
        break
      case 'unarchive-workspace':
        this.unarchiveWorkspace(msg.id)
        break
      case 'list-dir':
        this.listDir(ws, msg.path)
        break
      case 'update-settings':
        this.updateSettings(msg.settings)
        break
      case 'refine':
        this.handleRefine(ws, msg)
        break
      case 'delegate':
        this.handleDelegate(ws, msg as DelegateMessage)
        break
    }
  }

  // ── Whisper Transcription (native whisper.cpp) ─────────────────

  private async handleTranscription(ws: WebSocket, msg: TranscribeMessage) {
    try {
      const audioBuffer = Buffer.from(msg.audio, 'base64')
      const text = await speechManager.transcribeWebM(audioBuffer)
      this.sendTo(ws, {
        type: 'transcription',
        requestId: msg.requestId,
        text,
        elapsed: 0,
      })
    } catch (err: any) {
      console.error('[agent-mux] Transcription error:', err.message)
      this.sendTo(ws, {
        type: 'transcription',
        requestId: msg.requestId,
        text: '',
        elapsed: 0,
        error: err.message,
      })
    }
  }

  // ── Directory Listing ──────────────────────────────────────────

  private listDir(ws: WebSocket, requestedPath?: string) {
    const home = process.env.HOME || '/tmp'
    const raw = requestedPath?.trim() || home
    // Expand ~ to HOME
    const dirPath = raw.replace(/^~(?=\W|$|\/)/, home)

    try {
      if (!existsSync(dirPath)) {
        this.sendTo(ws, {
          type: 'dir-listing',
          path: dirPath,
          parent: null,
          entries: [],
          requestedPath: raw,
        })
        return
      }

      const stat = statSync(dirPath)
      if (!stat.isDirectory()) {
        this.sendTo(ws, {
          type: 'dir-listing',
          path: dirPath,
          parent: null,
          entries: [],
          requestedPath: raw,
        })
        return
      }

      const items = readdirSync(dirPath, { withFileTypes: true })
      const entries: DirEntry[] = items
        .filter(item => !item.name.startsWith('.'))
        .map(item => ({
          name: item.name,
          path: join(dirPath, item.name),
          isDir: item.isDirectory(),
        }))
        .sort((a, b) => {
          // Dirs first, then alphabetical
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      // Calculate parent
      const parent = dirPath === '/' ? null : dirname(dirPath)

      this.sendTo(ws, {
        type: 'dir-listing',
        path: dirPath,
        parent,
        entries,
        requestedPath: raw,
      })
    } catch (err: any) {
      console.error('[agent-mux] listDir error:', err.message)
      this.sendTo(ws, {
        type: 'dir-listing',
        path: dirPath,
        parent: null,
        entries: [],
        requestedPath: raw,
      })
    }
  }
}

// ── Server Setup ────────────────────────────────────────────────

/**
 * Strip ANSI sequences that produce blank/empty screens from scrollback.
 * Keeps text content, standard colors, and cursor movement, but removes:
 * - Screen clears (ESC [ 2 J)
 * - Alternate screen buffer toggles (ESC [ ? 1 0 4 9 h/l)
 * - DEC private mode sets that don't affect visible content
 *
 * This keeps saved scrollback compact and meaningful instead of filling
 * with rendered-blank escape sequences.
 */
function stripBlankScreenSequences(data: string): string {
  return data
    // Alternate screen buffer (most common source of "blank screen" on replay)
    .replace(/\x1b\[\?1049[hl]/g, '')
    // Clear entire screen
    .replace(/\x1b\[2J/g, '')
    // Clear from cursor to end of screen
    .replace(/\x1b\[0?J/g, '')
    // Application cursor keys mode
    .replace(/\x1b\[\?1[hl]/g, '')
    // Cursor visibility (DECSET 25)
    .replace(/\x1b\[\?25[hl]/g, '')
    // Mouse tracking modes (1000, 1002, 1003, 1005, 1006)
    .replace(/\x1b\[\?100[02356][hl]/g, '')
    // Bracketed paste mode (2004)
    .replace(/\x1b\[\?2004[hl]/g, '')
    // Cursor key mode
    .replace(/\x1b\[>[hl]/g, '')
    // DEC origin mode
    .replace(/\x1b\[\?6[hl]/g, '')
    // Auto-wrap mode
    .replace(/\x1b\[\?7[hl]/g, '')
    // DECKPAM / DECKPNM (application/normal keypad)
    .replace(/\x1b[=>]/g, '')
    // Character set selection (G0/G1 designate)
    .replace(/\x1b[()][0AB12UK]/g, '')
    // Restore/request cursor position
    .replace(/\x1b8/g, '')
    .replace(/\x1b7/g, '')
    .replace(/\x1b\[6n/g, '')
    // Collapse multiple consecutive newlines (blank terminal lines)
    .replace(/\n{4,}/g, '\n\n\n')
}

const manager = new SessionManager()

// Try HTTPS with Tailscale cert, fall back to plain WS
const CERT_DIR = join(__dirname, '..', 'certs')
const keyPath = join(CERT_DIR, 'claudebox.tail6183bd.ts.net.key')
const certPath = join(CERT_DIR, 'claudebox.tail6183bd.ts.net.crt')

let useTls = false
let tlsKey: string | null = null
let tlsCert: string | null = null

try {
  if (existsSync(keyPath) && existsSync(certPath)) {
    tlsKey = readFileSync(keyPath)
    tlsCert = readFileSync(certPath)
    useTls = true
  }
} catch {
  // certs not available — fall back to ws
}

let wss: WebSocketServer

if (useTls && tlsKey && tlsCert) {
  const server = createHttpsServer({ key: tlsKey, cert: tlsCert })
  wss = new WebSocketServer({ server })
  server.listen(PORT, () => {
    console.log(`[agent-mux] Listening on wss://localhost:${PORT} (TLS)`)
  })
} else {
  wss = new WebSocketServer({ port: PORT })
  console.log(`[agent-mux] Listening on ws://localhost:${PORT} (no TLS)`)
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress
  console.log(`[agent-mux] Client connected from ${ip}`)
  manager.addClient(ws)

  ws.on('message', (data) => {
    manager.handleMessage(ws, data.toString())
  })

  ws.on('close', () => {
    console.log(`[agent-mux] Client disconnected from ${ip}`)
    manager.removeClient(ws)
  })

  ws.on('error', (err) => {
    console.error('[agent-mux] WebSocket error:', err.message)
  })
})

console.log(`
╔══════════════════════════════════════════════════╗
║       Agent Multiplexer Backend :${PORT}           ║
║                                                  ║
║  WebSocket:  ${useTls ? 'wss' : 'ws'}://localhost:${PORT} ${useTls ? '(TLS)' : '      '}║
║  STT:       NVIDIA Parakeet TDT 0.6B v2 (sherpa-onnx) ║
║  State:      ${STATE_FILE}
║                                                  ║
║  Connect from the React app or any WS client.    ║
╚══════════════════════════════════════════════════╝
`)
