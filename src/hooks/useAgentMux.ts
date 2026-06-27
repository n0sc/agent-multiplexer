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
} from '../shared/protocol'

export interface AgentMuxState {
  sessions: SessionMeta[]
  activeSessionId: string | null
  connected: boolean
  alerts: AgentMuxAlert[]
}

export interface AgentMuxAlert {
  id: string
  sessionId: string
  message: string
  level: 'info' | 'warning' | 'error'
  timestamp: number
}

export interface AgentMuxActions {
  createSession: (opts: {
    name: string
    command: string
    args?: string[]
    cwd?: string
    agentType?: string
  }) => void
  sendInput: (sessionId: string, data: string) => void
  resizeSession: (sessionId: string, cols: number, rows: number) => void
  closeSession: (sessionId: string) => void
  archiveSession: (sessionId: string) => void
  unarchiveSession: (sessionId: string) => void
  switchSession: (sessionId: string) => void
  dismissAlert: (alertId: string) => void
  /** Send a raw message to the backend (used by VoiceInput for transcription) */
  sendRaw: (msg: ClientMessage) => void
}

// ── Output callback registry ────────────────────────────────────
// Terminal panes subscribe to output for their session via this store.
// This avoids re-rendering React on every byte of terminal output.

type OutputListener = (data: string) => void

class OutputStore {
  private listeners = new Map<string, Set<OutputListener>>()

  subscribe(sessionId: string, listener: OutputListener): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set())
    }
    this.listeners.get(sessionId)!.add(listener)
    return () => {
      this.listeners.get(sessionId)?.delete(listener)
    }
  }

  emit(sessionId: string, data: string) {
    this.listeners.get(sessionId)?.forEach(fn => fn(data))
  }
}

const outputStore = new OutputStore()

export { outputStore }

// ── Transcription callback registry ─────────────────────────────
// VoiceInput subscribes to transcription results via this store.

type TranscriptionListener = (text: string, requestId: string, error?: string) => void

const transcriptionListeners = new Set<TranscriptionListener>()

export function onTranscriptionResult(listener: TranscriptionListener): () => void {
  transcriptionListeners.add(listener)
  return () => { transcriptionListeners.delete(listener) }
}

// ── Hook ────────────────────────────────────────────────────────

export function useAgentMux(serverUrl: string): {
  state: AgentMuxState
  actions: AgentMuxActions
} {
  const wsRef = useRef<WebSocket | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [alerts, setAlerts] = useState<AgentMuxAlert[]>([])
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

  const switchSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    send({ type: 'switch-session', sessionId })
  }, [send])

  const dismissAlert = useCallback((alertId: string) => {
    setAlerts(prev => prev.filter(a => a.id !== alertId))
  }, [])

  return {
    state: {
      sessions,
      activeSessionId,
      connected,
      alerts,
    },
    actions: {
      createSession,
      sendInput,
      resizeSession,
      closeSession,
      archiveSession,
      unarchiveSession,
      switchSession,
      dismissAlert,
      sendRaw: send,
    },
  }
}
