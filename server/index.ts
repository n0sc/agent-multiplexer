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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type {
  ClientMessage,
  ServerMessage,
  SessionMeta,
  SessionStatus,
  AgentPreset,
  TranscribeMessage,
} from '../src/shared/protocol.js'
import { AGENT_PRESETS } from '../src/shared/protocol.js'
import { speechManager } from './speech-manager.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.AGENT_MUX_PORT || '3461', 10)
const STATE_DIR = join(process.env.HOME || '/tmp', '.agent-multiplexer')
const STATE_FILE = join(STATE_DIR, 'sessions.json')

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

// ── Session Manager ─────────────────────────────────────────────

interface ManagedSession {
  meta: SessionMeta
  pty: pty.IPty | null  // null after process exits or server restart
  preset: AgentPreset
  recentOutput: string
  statusTimer: NodeJS.Timeout | null
  activeViewers: Set<WebSocket>
}

class SessionManager {
  private sessions = new Map<string, ManagedSession>()
  private clients = new Set<WebSocket>()

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
        recentOutput: '',
        statusTimer: null,
        activeViewers: new Set(),
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
  }

  removeClient(ws: WebSocket) {
    this.clients.delete(ws)
    for (const session of this.sessions.values()) {
      session.activeViewers.delete(ws)
    }
  }

  // ── Session Lifecycle ──────────────────────────────────────────

  createSession(opts: {
    name: string
    command: string
    args?: string[]
    cwd?: string
    agentType?: string
  }): SessionMeta {
    const id = randomUUID().slice(0, 8)
    const presetKey = opts.agentType || this.guessAgentType(opts.command)
    const preset = AGENT_PRESETS[presetKey] || AGENT_PRESETS.shell

    const cwd = opts.cwd || process.env.HOME || '/tmp'
    const ptyProcess = pty.spawn(opts.command, opts.args || [], {
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
  }

  archiveSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // Kill the PTY if alive — we keep the metadata for history
    if (session.pty) {
      session.pty.kill()
      session.pty = null
    }

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

    this.broadcast({
      type: 'output',
      sessionId,
      data,
    })

    session.recentOutput = (session.recentOutput + data).slice(-2000)
    this.detectStatus(sessionId, data.length)
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

  // ── Utilities ──────────────────────────────────────────────────

  private guessAgentType(command: string): string {
    if (command.includes('claude')) return 'claude'
    if (command.includes('hermes')) return 'hermes'
    return 'shell'
  }

  private getAllMeta(): SessionMeta[] {
    return Array.from(this.sessions.values()).map(s => s.meta)
  }

  private persistState() {
    saveState(this.getAllMeta())
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
      case 'switch-session':
        this.markViewed(msg.sessionId, ws)
        break
      case 'transcribe':
        this.handleTranscription(ws, msg)
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
}

// ── Server Setup ────────────────────────────────────────────────

const manager = new SessionManager()

const wss = new WebSocketServer({ port: PORT })

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
║  WebSocket:  ws://localhost:${PORT}                ║
║  STT:       NVIDIA Parakeet TDT 0.6B v2 (sherpa-onnx) ║
║  State:      ${STATE_FILE}
║                                                  ║
║  Connect from the React app or any WS client.    ║
╚══════════════════════════════════════════════════╝
`)
