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

import { useCallback, useState, useEffect } from 'react'
import { useAgentMux, onTranscriptionResult } from './hooks/useAgentMux'
import { SessionList } from './components/SessionList'
import { TerminalPane } from './components/TerminalPane'
import { VoiceInput } from './components/VoiceInput'
import { ActivityBar } from './components/ActivityBar'
import { DelegationModal } from './components/DelegationModal'
import { WorkspaceModal } from './components/WorkspaceModal'
import { SettingsModal } from './components/SettingsModal'
import { AGENT_PRESETS } from './shared/protocol'
import type { Workspace } from './shared/protocol'
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
  serverUrl,
  height = '100vh',
  showVoice = true,
  showSidebar = true,
  onNeedsInput,
}: AgentMultiplexerProps) {
  // Derive WS URL from current page origin when not explicitly provided
  // Use wss:// when page is served over https, ws:// otherwise
  const resolvedUrl = serverUrl ?? (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:3461`
    : 'ws://localhost:3461')

  const { state, actions } = useAgentMux(resolvedUrl)
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null)
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showDelegationModal, setShowDelegationModal] = useState(false)

  // Close sidebar on session select (mobile)
  const handleSelect = useCallback((id: string) => {
    actions.switchSession(id)
    setSidebarOpen(false)
  }, [actions])

  const handleCreate = useCallback((preset: string) => {
    const p = AGENT_PRESETS[preset]
    if (!p) return
    actions.createSession({
      name: `${p.agentType}-${state.sessions.length + 1}`,
      command: p.command,
      args: p.args,
      agentType: p.agentType,
    })
    setSidebarOpen(false)
  }, [actions, state.sessions.length])

  const handleLaunchWorkspace = useCallback((ws: Workspace) => {
    const preset = AGENT_PRESETS[ws.agentType]
    if (!preset) return

    actions.createSession({
      name: ws.name,
      command: preset.command,
      args: ws.args || preset.args,
      cwd: ws.cwd,
      agentType: ws.agentType,
      instructions: ws.instructions,
    })
    setSidebarOpen(false)
  }, [actions])

  const handleEditWorkspace = useCallback((ws: Workspace | null) => {
    setEditingWorkspace(ws)
    setShowWorkspaceModal(true)
  }, [])

  const handleSaveWorkspace = useCallback((data: { name: string; agentType: string; cwd: string; args?: string[]; icon?: string; instructions?: string }) => {
    if (editingWorkspace) {
      actions.updateWorkspace({ id: editingWorkspace.id, ...data })
    } else {
      actions.createWorkspace(data)
    }
    setShowWorkspaceModal(false)
    setEditingWorkspace(null)
  }, [actions, editingWorkspace])

  const handleDeleteWorkspace = useCallback((id: string) => {
    actions.deleteWorkspace(id)
    setShowWorkspaceModal(false)
    setEditingWorkspace(null)
  }, [actions])

  const handleDeleteAllArchived = useCallback(() => {
    for (const s of state.sessions) {
      if (s.archived) actions.deleteSession(s.id)
    }
    for (const w of state.workspaces) {
      if (w.archived) actions.deleteWorkspace(w.id)
    }
  }, [actions, state.sessions, state.workspaces])

  const activeSession = state.sessions.find(s => s.id === state.activeSessionId)

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
    <div className={`agent-mux${sidebarOpen ? ' sidebar-open' : ''}`} style={{ height }}>
      {/* Mobile sidebar overlay */}
      <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />

      {showSidebar && (
        <SessionList
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          workspaces={state.workspaces}
          onSelect={handleSelect}
          onClose={actions.closeSession}
          onArchive={actions.archiveSession}
          onUnarchive={actions.unarchiveSession}
          onDelete={actions.deleteSession}
          onCreate={handleCreate}
          onLaunchWorkspace={handleLaunchWorkspace}
          onEditWorkspace={handleEditWorkspace}
          onArchiveWorkspace={actions.archiveWorkspace}
          onUnarchiveWorkspace={actions.unarchiveWorkspace}
          onDeleteWorkspace={actions.deleteWorkspace}
          onDeleteAllArchived={handleDeleteAllArchived}
          onCloseDrawer={() => setSidebarOpen(false)}
        />
      )}

      <div className="main-area">
        {/* Top bar: hamburger + connection status */}
        <div className="connection-bar">
          {showSidebar && (
            <button className="hamburger-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                {sidebarOpen ? (
                  <path d="M4.75 3.75L14.25 13.25M4.75 13.25L14.25 3.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
                ) : (
                  <>
                    <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </>
                )}
              </svg>
            </button>
          )}
          <span className={`connection-dot ${state.connected ? 'connected' : 'disconnected'}`} />
          <span className="connection-text">
            {activeSession ? activeSession.name : (state.connected ? 'Connected' : 'Connecting…')}
          </span>
          {activeSession && (
            <span className="mobile-status" style={{ color: {
              idle: '#6e7681', working: '#58a6ff', 'needs-input': '#d29922',
              completed: '#3fb950', failed: '#ff7b72', stopped: '#6e7681', detached: '#6e7681',
            }[activeSession.status] ?? '#6e7681' }}>
              ●
            </span>
          )}
          {activeSession && (
            <button
              className="delegate-btn"
              onClick={() => setShowDelegationModal(true)}
              title="Delegate task to another session"
            >
              ↗
            </button>
          )}
          <button
            className="settings-gear-btn"
            onClick={() => setShowSettingsModal(true)}
            title="Settings"
          >
            ⚙️
          </button>
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

        {/* Structured activity bar — shows tool calls, tokens, thinking */}
        <ActivityBar
          sessionId={state.activeSessionId}
          activity={activeSession?.structuredActivity}
        />

        {/* Voice bar */}
        {showVoice && (
          <VoiceInput
            onTranscript={handleTranscript}
            sessionName={activeSession?.name ?? null}
            agentType={activeSession?.agentType}
            sendToServer={actions.sendRaw}
            onTranscriptionResult={onTranscriptionResult}
            refine={actions.refine}
            refineEnabled={!!state.settings.openrouterApiKey}
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

      {/* Workspace modal */}
      {showWorkspaceModal && (
        <WorkspaceModal
          workspace={editingWorkspace}
          onSave={handleSaveWorkspace}
          onDelete={handleDeleteWorkspace}
          onClose={() => { setShowWorkspaceModal(false); setEditingWorkspace(null) }}
          listDir={actions.listDir}
        />
      )}

      {showSettingsModal && (
        <SettingsModal
          settings={state.settings}
          onSave={actions.updateSettings}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

      {showDelegationModal && activeSession && (
        <DelegationModal
          fromSession={activeSession}
          sessions={state.sessions}
          onDelegate={actions.delegate}
          onClose={() => setShowDelegationModal(false)}
        />
      )}
    </div>
  )
}
