/**
 * useAgentMux — React hook that manages the WebSocket connection to the
 * backend and exposes session state + actions.
 *
 * This is the core integration point. The component consumer doesn't need
 * to know about WebSockets at all — they just use this hook.
 */

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import type {
  ServerMessage,
  ClientMessage,
  SessionMeta,
  SessionStatus,
  Workspace,
  DirEntry,
  AppSettings,
  AgentEvent,
  SessionOverrides,
} from '../shared/protocol'

export interface AgentMuxState {
  sessions: SessionMeta[]
  activeSessionId: string | null
  connected: boolean
  alerts: AgentMuxAlert[]
  workspaces: Workspace[]
  settings: AppSettings
}

export interface AgentMuxAlert {
  id: string
  sessionId: string
  message: string
  level: 'info' | 'warning' | 'error'
  timestamp: number
}

export interface DirListing {
  path: string
  parent: string | null
  entries: DirEntry[]
}

export interface AgentMuxActions {
  createSession: (opts: {
    name: string
    command: string
    args?: string[]
    cwd?: string
    agentType?: string
    instructions?: string
    overrides?: SessionOverrides
  }) => void
  sendInput: (sessionId: string, data: string) => void
  resizeSession: (sessionId: string, cols: number, rows: number) => void
  closeSession: (sessionId: string) => void
  archiveSession: (sessionId: string) => void
  unarchiveSession: (sessionId: string) => void
  deleteSession: (sessionId: string) => void
  switchSession: (sessionId: string) => void
  dismissAlert: (alertId: string) => void
  createWorkspace: (ws: { name: string; agentType: string; cwd: string; args?: string[]; icon?: string; instructions?: string }) => void
  updateWorkspace: (ws: { id: string; name?: string; agentType?: string; cwd?: string; args?: string[]; icon?: string; instructions?: string }) => void
  deleteWorkspace: (id: string) => void
  archiveWorkspace: (id: string) => void
  unarchiveWorkspace: (id: string) => void
  listDir: (path: string) => Promise<DirListing>
  updateSettings: (settings: Partial<AppSettings>) => void
  refine: (text: string, agentType?: string) => Promise<string>
  /** Delegate a task from one session to another */
  delegate: (fromSessionId: string, toSessionId: string, task: string) => void
  /** Send a raw message to the backend (used by VoiceInput for transcription) */
  sendRaw: (msg: ClientMessage) => void
}

// ── Output callback registry ────────────────────────────────────
// Terminal panes subscribe to output for their session via this store.
// This avoids re-rendering React on every byte of terminal output.

type OutputListener = (data: string) => void

class OutputStore {
  private listeners = new Map<string, Set<OutputListener>>()
  // Buffer scrollback so new subscribers get past output on reconnect
  private scrollback = new Map<string, string>()

  subscribe(sessionId: string, listener: OutputListener): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set())
    }
    this.listeners.get(sessionId)!.add(listener)

    // Replay buffered scrollback to new subscriber immediately
    const buffered = this.scrollback.get(sessionId)
    if (buffered && buffered.length > 0) {
      listener(buffered)
    }

    return () => {
      this.listeners.get(sessionId)?.delete(listener)
    }
  }

  emit(sessionId: string, data: string) {
    // Buffer last 50KB for replay to late subscribers
    const prev = this.scrollback.get(sessionId) || ''
    this.scrollback.set(sessionId, (prev + data).slice(-50000))

    this.listeners.get(sessionId)?.forEach(fn => fn(data))
  }
}

const outputStore = new OutputStore()

export { outputStore }

// ── Agent event store ───────────────────────────────────────────
// Components subscribe to structured agent events (tool calls, usage, etc.)
// per session, same pub/sub pattern as OutputStore. Events are buffered per
// session so the activity rail shows recent history on mount/reconnect.

type AgentEventListener = (event: AgentEvent) => void

class AgentEventStore {
  private listeners = new Map<string, Set<AgentEventListener>>()
  // Buffer last 50 events per session for late subscribers
  private history = new Map<string, AgentEvent[]>()
  private readonly MAX_HISTORY = 50

  subscribe(sessionId: string, listener: AgentEventListener): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set())
    }
    this.listeners.get(sessionId)!.add(listener)

    // Replay buffered history to new subscriber
    const buffered = this.history.get(sessionId)
    if (buffered) {
      for (const event of buffered) listener(event)
    }

    return () => {
      this.listeners.get(sessionId)?.delete(listener)
    }
  }

  emit(sessionId: string, event: AgentEvent): void {
    const prev = this.history.get(sessionId) || []
    this.history.set(sessionId, [...prev, event].slice(-this.MAX_HISTORY))

    this.listeners.get(sessionId)?.forEach(fn => fn(event))
  }

  /** Clear history when switching sessions or on demand */
  clear(sessionId: string): void {
    this.history.delete(sessionId)
  }
}

const agentEventStore = new AgentEventStore()

export { agentEventStore }

// ── Transcription callback registry ─────────────────────────────
// VoiceInput subscribes to transcription results via this store.

type TranscriptionListener = (text: string, requestId: string, error?: string) => void

const transcriptionListeners = new Set<TranscriptionListener>()

export function onTranscriptionResult(listener: TranscriptionListener): () => void {
  transcriptionListeners.add(listener)
  return () => { transcriptionListeners.delete(listener) }
}

// ── Directory listing callback registry ─────────────────────────
// Used by the FolderBrowser component — resolves a promise per request.

type DirListingResolver = (listing: DirListing) => void

const pendingDirRequests = new Map<number, DirListingResolver>()
let dirRequestCounter = 0

export function resolveDirRequest(id: number, listing: DirListing) {
  const resolver = pendingDirRequests.get(id)
  if (resolver) {
    resolver(listing)
    pendingDirRequests.delete(id)
  }
}

// ── Refine callback registry ────────────────────────────────────
// VoiceInput subscribes to refine results via this store.

type RefineListener = (text: string, requestId: string, error?: string) => void

const refineListeners = new Set<RefineListener>()

export function onRefineResult(listener: RefineListener): () => void {
  refineListeners.add(listener)
  return () => { refineListeners.delete(listener) }
}

// ── Default settings (before server sends real ones) ────────────

const DEFAULT_SETTINGS: AppSettings = {
  openrouterApiKey: '',
  refineModel: '',
}


// ── Hook ────────────────────────────────────────────────────────

export function useAgentMux(serverUrl: string): {
  state: AgentMuxState
  actions: AgentMuxActions
} {
  const wsRef = useRef<WebSocket | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)  // avoids stale closure in WS handler
  const [connected, setConnected] = useState(false)
  const [alerts, setAlerts] = useState<AgentMuxAlert[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  // Reconnect trigger — incrementing this forces the effect to re-run
  const [reconnectTick, setReconnectTick] = useState(0)

  // ── WebSocket connection (with auto-reconnect) ─────────────────

  useEffect(() => {
    let ws: WebSocket
    let closed = false

    function connect() {
      ws = new WebSocket(serverUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        console.log('[agent-mux] Connected to', serverUrl)
      }

      ws.onmessage = (event) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }

        switch (msg.type) {
          case 'sessions':
            setSessions(msg.sessions)
            // Auto-select the most recent live session on reconnect
            // Use ref to avoid stale closure — state may be null on first mount
            const current = activeSessionRef.current
            if (!current || !msg.sessions.find(s => s.id === current && !s.archived)) {
              const live = msg.sessions
                .filter(s => !s.archived && s.status !== 'completed' && s.status !== 'failed' && s.status !== 'stopped')
                .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime())
              if (live.length > 0) {
                activeSessionRef.current = live[0].id
                setActiveSessionId(live[0].id)
              }
            }
            break

          case 'session-created':
            setSessions(prev => [...prev, msg.session])
            setActiveSessionId(msg.session.id)
            break

          case 'session-closed':
            setSessions(prev =>
              prev.map(s =>
                s.id === msg.sessionId
                  ? { ...s, status: msg.exitCode === 0 ? 'completed' as SessionStatus : 'failed' as SessionStatus }
                  : s
              )
            )
            break

          case 'output':
            outputStore.emit(msg.sessionId, msg.data)
            break

          case 'agent-event':
            agentEventStore.emit(msg.sessionId, msg.event)
            break

          case 'status-change':
            setSessions(prev =>
              prev.map(s =>
                s.id === msg.sessionId
                  ? { ...s, status: msg.status, summary: msg.summary }
                  : s
              )
            )
            break

          case 'alert':
            {
              const alert: AgentMuxAlert = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                sessionId: msg.sessionId,
                message: msg.message,
                level: msg.level,
                timestamp: Date.now(),
              }
              setAlerts(prev => [...prev, alert])
            }
            break

          case 'transcription':
            transcriptionListeners.forEach(fn => fn(msg.text, msg.requestId, msg.error))
            break

          case 'workspaces':
            setWorkspaces(msg.workspaces)
            break

          case 'dir-listing':
            {
              const listing: DirListing = {
                path: msg.path,
                parent: msg.parent,
                entries: msg.entries,
              }
              pendingDirRequests.forEach((resolver, id) => {
                resolver(listing)
                pendingDirRequests.delete(id)
              })
            }
            break

          case 'settings':
            setSettings(msg.settings)
            break

          case 'refine-result':
            refineListeners.forEach(fn => fn(msg.text, msg.requestId, msg.error))
            break
        }
      }

      ws.onclose = () => {
        setConnected(false)
        console.log('[agent-mux] Disconnected')
        wsRef.current = null
        if (!closed) {
          // Auto-reconnect after 2s
          setTimeout(() => {
            if (!closed) setReconnectTick(t => t + 1)
          }, 2000)
        }
      }

      ws.onerror = () => {
        // onclose will handle reconnect
      }
    }

    connect()

    return () => {
      closed = true
      ws.close()
    }
  }, [serverUrl, reconnectTick])

  // ── Actions ────────────────────────────────────────────────────

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const createSession = useCallback((opts: Parameters<AgentMuxActions['createSession']>[0]) => {
    send({ type: 'create-session', ...opts })
  }, [send])

  const sendInput = useCallback((sessionId: string, data: string) => {
    send({ type: 'input', sessionId, data })
  }, [send])

  const resizeSession = useCallback((sessionId: string, cols: number, rows: number) => {
    send({ type: 'resize', sessionId, cols, rows })
  }, [send])

  const closeSession = useCallback((sessionId: string) => {
    send({ type: 'close-session', sessionId })
  }, [send])

  const archiveSession = useCallback((sessionId: string) => {
    send({ type: 'archive-session', sessionId })
  }, [send])

  const unarchiveSession = useCallback((sessionId: string) => {
    send({ type: 'unarchive-session', sessionId })
  }, [send])

  const deleteSession = useCallback((sessionId: string) => {
    send({ type: 'delete-session', sessionId })
  }, [send])

  const switchSession = useCallback((sessionId: string) => {
    activeSessionRef.current = sessionId
    setActiveSessionId(sessionId)
    send({ type: 'switch-session', sessionId })
  }, [send])

  const dismissAlert = useCallback((alertId: string) => {
    setAlerts(prev => prev.filter(a => a.id !== alertId))
  }, [])

  const createWorkspace = useCallback((ws: { name: string; agentType: string; cwd: string; args?: string[]; icon?: string; instructions?: string }) => {
    send({ type: 'create-workspace', ...ws })
  }, [send])

  const updateWorkspace = useCallback((ws: { id: string; name?: string; agentType?: string; cwd?: string; args?: string[]; icon?: string; instructions?: string }) => {
    send({ type: 'update-workspace', ...ws })
  }, [send])

  const deleteWorkspace = useCallback((id: string) => {
    send({ type: 'delete-workspace', id })
  }, [send])

  const archiveWorkspace = useCallback((id: string) => {
    send({ type: 'archive-workspace', id })
  }, [send])

  const unarchiveWorkspace = useCallback((id: string) => {
    send({ type: 'unarchive-workspace', id })
  }, [send])

  const listDir = useCallback((path: string): Promise<DirListing> => {
    return new Promise((resolve) => {
      const id = ++dirRequestCounter
      pendingDirRequests.set(id, resolve)
      send({ type: 'list-dir', path })
      setTimeout(() => {
        if (pendingDirRequests.has(id)) {
          pendingDirRequests.delete(id)
          resolve({ path, parent: null, entries: [] })
        }
      }, 5000)
    })
  }, [send])

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    send({ type: 'update-settings', settings: patch })
  }, [send])

  const refine = useCallback((text: string, agentType?: string): Promise<string> => {
    return new Promise((resolve) => {
      const requestId = `refine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const unsubscribe = onRefineResult((resultText, resultId, error) => {
        if (resultId !== requestId) return
        unsubscribe()
        if (error) resolve(text)  // fall back to original on error
        else resolve(resultText || text)
      })
      send({ type: 'refine', requestId, text, agentType })
      // Timeout — resolve with original text after 15s
      setTimeout(() => {
        unsubscribe()
        resolve(text)
      }, 15000)
    })
  }, [send])

  return {
    state: {
      sessions,
      activeSessionId,
      connected,
      alerts,
      workspaces,
      settings,
    },
    actions: {
      createSession,
      sendInput,
      resizeSession,
      closeSession,
      archiveSession,
      unarchiveSession,
      deleteSession,
      switchSession,
      dismissAlert,
      createWorkspace,
      updateWorkspace,
      deleteWorkspace,
      archiveWorkspace,
      unarchiveWorkspace,
      listDir,
      updateSettings,
      refine,
      delegate: (fromSessionId: string, toSessionId: string, task: string) => {
        send({ type: 'delegate', fromSessionId, toSessionId, task })
      },
      sendRaw: send,
    },
  }
}
