/**
 * AgentMultiplexer — The main embeddable component.
 *
 * Drop this anywhere:
 *
 *   import { AgentMultiplexer } from 'agent-multiplexer'
 *
 *   <AgentMultiplexer
 *     serverUrl="ws://localhost:3461/ws"
 *     height="100vh"
 *   />
 *
 * Features:
 * - Session sidebar with live status indicators
 * - Terminal pane (xterm.js) for the active session
 * - Voice dictation (hold Space or click mic)
 * - Alert toasts for sessions needing input
 * - Quick-create buttons for Claude / Hermes / Shell
 */

import { useCallback, useState } from 'react'
import { useAgentMux, onTranscriptionResult } from './hooks/useAgentMux'
import { SessionList } from './components/SessionList'
import { TerminalPane } from './components/TerminalPane'
import { VoiceInput } from './components/VoiceInput'
import { AGENT_PRESETS } from './shared/protocol'
import './styles.css'

export interface AgentMultiplexerProps {
  /** WebSocket URL of the backend server */
  serverUrl?: string
  /** Height of the component (CSS value) */
  height?: string
  /** Show/hide the voice input bar */
  showVoice?: boolean
  /** Show/hide the session sidebar */
  showSidebar?: boolean
  /** Called when a session needs input (for external notifications) */
  onNeedsInput?: (sessionName: string) => void
}

export function AgentMultiplexer({
  serverUrl = 'ws://localhost:3461',
  height = '100vh',
  showVoice = true,
  showSidebar = true,
  onNeedsInput,
}: AgentMultiplexerProps) {
  const { state, actions } = useAgentMux(serverUrl)
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())

  const activeSession = state.sessions.find(s => s.id === state.activeSessionId)

  // ── Create session from preset ─────────────────────────────────

  const handleCreate = useCallback((preset: string) => {
    const p = AGENT_PRESETS[preset]
    if (!p) return
    actions.createSession({
      name: `${p.agentType}-${state.sessions.length + 1}`,
      command: p.command,
      args: p.args,
      agentType: p.agentType,
    })
  }, [actions, state.sessions.length])

  // ── Voice transcript → active session ──────────────────────────

  const handleTranscript = useCallback((text: string) => {
    if (state.activeSessionId) {
      actions.sendInput(state.activeSessionId, text)
    }
  }, [actions, state.activeSessionId])

  // ── Terminal callbacks ─────────────────────────────────────────

  const handleTerminalInput = useCallback((data: string) => {
    if (state.activeSessionId) {
      actions.sendInput(state.activeSessionId, data)
    }
  }, [actions, state.activeSessionId])

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    if (state.activeSessionId) {
      actions.resizeSession(state.activeSessionId, cols, rows)
    }
  }, [actions, state.activeSessionId])

  // ── Visible alerts (not dismissed) ─────────────────────────────

  const visibleAlerts = state.alerts.filter(a => !dismissedAlerts.has(a.id))

  return (
    <div className="agent-mux" style={{ height }}>
      {showSidebar && (
        <SessionList
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          onSelect={actions.switchSession}
          onClose={actions.closeSession}
          onArchive={actions.archiveSession}
          onUnarchive={actions.unarchiveSession}
          onCreate={handleCreate}
        />
      )}

      <div className="main-area">
        {/* Connection status */}
        <div className="connection-bar">
          <span className={`connection-dot ${state.connected ? 'connected' : 'disconnected'}`} />
          <span className="connection-text">
            {state.connected ? 'Connected' : 'Connecting…'}
          </span>
        </div>

        {/* Terminal — all sessions stay mounted, hidden via CSS to preserve scrollback */}
        <div className="terminal-area">
          {state.sessions.filter(s => !s.archived).map(session => (
            <TerminalPane
              key={session.id}
              session={session}
              active={session.id === state.activeSessionId}
              onInput={handleTerminalInput}
              onResize={handleTerminalResize}
            />
          ))}
          {!activeSession && (
            <div className="no-session">
              <div className="no-session-icon">🎛️</div>
              <p>No session selected</p>
              <p className="hint">
                Create a Claude, Hermes, or Shell session from the sidebar →
              </p>
            </div>
          )}
        </div>

        {/* Voice bar */}
        {showVoice && (
          <VoiceInput
            onTranscript={handleTranscript}
            sessionName={activeSession?.name ?? null}
            sendToServer={actions.sendRaw}
            onTranscriptionResult={onTranscriptionResult}
          />
        )}
      </div>

      {/* Alert toasts */}
      <div className="alert-toasts">
        {visibleAlerts.map(alert => (
          <div
            key={alert.id}
            className={`alert-toast ${alert.level}`}
            onClick={() => {
              setDismissedAlerts(prev => new Set(prev).add(alert.id))
              actions.switchSession(alert.sessionId)
            }}
          >
            <span className="alert-icon">
              {alert.level === 'warning' ? '⚠️' : alert.level === 'error' ? '❌' : 'ℹ️'}
            </span>
            <span>{alert.message}</span>
            <span className="alert-dismiss">×</span>
          </div>
        ))}
      </div>
    </div>
  )
}
