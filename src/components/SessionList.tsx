/**
 * SessionList — Sidebar showing all sessions with live status indicators.
 *
 * Features:
 * - Color-coded status dots (pulsing for active/needs-input)
 * - Unread output badges
 * - Click to switch sessions
 * - Archive button (×) moves sessions/workspaces to archived section
 * - Collapsible archived section with restore + permanent delete
 * - Workspace buttons for quick session creation in specific directories
 * - Quick-create buttons for preset agents
 */

import { useState } from 'react'
import type { SessionMeta, SessionStatus, Workspace } from '../shared/protocol'
import { AGENT_PRESETS } from '../shared/protocol'

interface SessionListProps {
  sessions: SessionMeta[]
  activeSessionId: string | null
  workspaces: Workspace[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  onCreate: (preset: string) => void
  onLaunchWorkspace: (workspace: Workspace) => void
  onEditWorkspace: (workspace: Workspace | null) => void
  onArchiveWorkspace: (id: string) => void
  onUnarchiveWorkspace: (id: string) => void
  onDeleteWorkspace: (id: string) => void
  onDeleteAllArchived?: () => void
  onCloseDrawer?: () => void
}

const STATUS_CONFIG: Record<SessionStatus, { icon: string; color: string; pulse: boolean }> = {
  idle:          { icon: '○', color: '#6e7681', pulse: false },
  working:       { icon: '●', color: '#58a6ff', pulse: true  },
  'needs-input': { icon: '⚠', color: '#d29922', pulse: true  },
  completed:     { icon: '✓', color: '#3fb950', pulse: false },
  failed:        { icon: '✕', color: '#ff7b72', pulse: false },
  stopped:       { icon: '■', color: '#6e7681', pulse: false },
  detached:      { icon: '◇', color: '#6e7681', pulse: false },
}

export function SessionList({
  sessions, activeSessionId, workspaces,
  onSelect, onClose, onArchive, onUnarchive, onDelete,
  onCreate,
  onLaunchWorkspace, onEditWorkspace,
  onArchiveWorkspace, onUnarchiveWorkspace, onDeleteWorkspace,
  onDeleteAllArchived,
  onCloseDrawer,
}: SessionListProps) {
  const [showArchived, setShowArchived] = useState(false)
  const [showWorkspaces, setShowWorkspaces] = useState(true)

  const activeSessions = sessions.filter(s => !s.archived)
  const archivedSessions = sessions.filter(s => s.archived)
  const activeWorkspaces = workspaces.filter(w => !w.archived)
  const archivedWorkspaces = workspaces.filter(w => w.archived)
  const totalArchived = archivedSessions.length + archivedWorkspaces.length
  const needsAttention = activeSessions.filter(s =>
    s.status === 'needs-input' || s.hasUnreadOutput
  ).length

  return (
    <div className="session-list">
      <div className="session-list-header">
        <h2>Sessions</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {needsAttention > 0 && (
            <span className="attention-badge">{needsAttention}</span>
          )}
          {onCloseDrawer && (
            <button className="drawer-close-btn" onClick={onCloseDrawer} title="Close">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Workspaces ── */}
      <div className="workspace-section">
        <div
          className="workspace-header"
          onClick={() => setShowWorkspaces(!showWorkspaces)}
          title={showWorkspaces ? 'Collapse workspaces' : 'Expand workspaces'}
        >
          <span className={`collapse-arrow ${showWorkspaces ? 'open' : ''}`}>▶</span>
          <span className="workspace-title">Workspaces</span>
          <button
            className="workspace-add-btn"
            onClick={(e) => {
              e.stopPropagation()
              onEditWorkspace(null)
            }}
            title="New workspace"
          >
            +
          </button>
        </div>
        {showWorkspaces && (
          activeWorkspaces.length > 0 ? (
          <div className="workspace-list">
            {activeWorkspaces.map(ws => {
              const preset = AGENT_PRESETS[ws.agentType]
              const color = preset?.accentColor || '#8b949e'
              return (
                <div
                  key={ws.id}
                  className="workspace-item"
                  onClick={() => onLaunchWorkspace(ws)}
                  style={{ borderLeftColor: color }}
                  title={`${ws.name} — ${ws.agentType} in ${ws.cwd}`}
                >
                  <span className="workspace-icon">{ws.icon || '📁'}</span>
                  <div className="workspace-info">
                    <div className="workspace-name">{ws.name}</div>
                    <div className="workspace-meta">
                      <span style={{ color }}>{ws.agentType}</span>
                      <span className="workspace-cwd">{ws.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
                    </div>
                  </div>
                  <button
                    className="workspace-archive-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onEditWorkspace(ws)
                    }}
                    title="Edit workspace"
                  >
                    ✎
                  </button>
                  <button
                    className="workspace-archive-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onArchiveWorkspace(ws.id)
                    }}
                    title="Archive workspace"
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="workspace-empty">
            No workspaces. Click + to add one.
          </div>
        ))}
      </div>

      <div className="session-list-items">
        {activeSessions.map(session => {
          const sc = STATUS_CONFIG[session.status]
          const isActive = session.id === activeSessionId
          return (
            <div
              key={session.id}
              className={`session-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelect(session.id)}
              style={isActive ? { borderLeftColor: session.accentColor } : {}}
            >
              <span
                className={`status-icon ${sc.pulse ? 'pulse' : ''}`}
                style={{ color: sc.color }}
              >
                {sc.icon}
              </span>
              <div className="session-info">
                <div className="session-name">{session.name}</div>
                <div className="session-summary">
                  {session.summary}
                  {session.structuredActivity?.active && (
                    <span className="sidebar-activity">
                      {' '}· 🔧{session.structuredActivity.toolCallCount}
                      {(session.structuredActivity.inputTokens > 0 || session.structuredActivity.outputTokens > 0) && (
                        <span title="Token usage">
                          {' '}· {(session.structuredActivity.inputTokens / 1000).toFixed(0)}k→{(session.structuredActivity.outputTokens / 1000).toFixed(0)}k
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
              {session.hasUnreadOutput && !isActive && (
                <span className="unread-dot" />
              )}
              <button
                className="close-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  onArchive(session.id)
                }}
                title="Archive session"
              >
                ×
              </button>
            </div>
          )
        })}

        {activeSessions.length === 0 && totalArchived === 0 && activeWorkspaces.length === 0 && (
          <div className="empty-state">
            No sessions yet.
            <br />
            Create one below ↓
          </div>
        )}
      </div>

      {/* Archived section */}
      {totalArchived > 0 && (
        <div className="archived-section">
          <button
            className="archived-toggle"
            onClick={() => setShowArchived(!showArchived)}
          >
            <span className={`archived-arrow ${showArchived ? 'open' : ''}`}>▶</span>
            Archived ({totalArchived})
          </button>
          {showArchived && onDeleteAllArchived && (
            <button
              className="archived-delete-all"
              onClick={() => {
                if (confirm(`Delete all ${totalArchived} archived items? This cannot be undone.`)) {
                  onDeleteAllArchived()
                }
              }}
              title="Delete all archived items"
            >
              🗑 Delete all
            </button>
          )}
          {showArchived && (
            <div className="archived-items">
              {/* Archived sessions */}
              {archivedSessions.map(session => (
                <div key={session.id} className="session-item archived">
                  <span className="status-icon" style={{ color: '#6e7681' }}>■</span>
                  <div className="session-info">
                    <div className="session-name">{session.name}</div>
                    <div className="session-summary">{session.summary}</div>
                  </div>
                  <button
                    className="restore-btn"
                    onClick={() => onUnarchive(session.id)}
                    title="Restore session"
                  >
                    ↺
                  </button>
                  <button
                    className="delete-btn"
                    onClick={() => {
                      if (confirm(`Permanently delete session "${session.name}"?`)) {
                        onDelete(session.id)
                      }
                    }}
                    title="Delete permanently"
                  >
                    🗑
                  </button>
                </div>
              ))}
              {/* Archived workspaces */}
              {archivedWorkspaces.map(ws => {
                const preset = AGENT_PRESETS[ws.agentType]
                const color = preset?.accentColor || '#8b949e'
                return (
                  <div key={ws.id} className="session-item archived">
                    <span className="status-icon">{ws.icon || '📁'}</span>
                    <div className="session-info">
                      <div className="session-name">{ws.name}</div>
                      <div className="session-summary">
                        <span style={{ color }}>{ws.agentType}</span> — {ws.cwd.replace(/^\/Users\/[^/]+/, '~')}
                      </div>
                    </div>
                    <button
                      className="restore-btn"
                      onClick={() => onUnarchiveWorkspace(ws.id)}
                      title="Restore workspace"
                    >
                      ↺
                    </button>
                    <button
                      className="delete-btn"
                      onClick={() => {
                        if (confirm(`Permanently delete workspace "${ws.name}"?`)) {
                          onDeleteWorkspace(ws.id)
                        }
                      }}
                      title="Delete permanently"
                    >
                      🗑
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="session-create-bar">
        <button
          className="create-btn"
          onClick={() => onCreate('claude')}
          style={{ borderColor: AGENT_PRESETS.claude.accentColor, color: AGENT_PRESETS.claude.accentColor }}
        >
          + Claude
        </button>
        <button
          className="create-btn"
          onClick={() => onCreate('hermes')}
          style={{ borderColor: AGENT_PRESETS.hermes.accentColor, color: AGENT_PRESETS.hermes.accentColor }}
        >
          + Hermes
        </button>
        <button
          className="create-btn"
          onClick={() => onCreate('shell')}
          style={{ borderColor: AGENT_PRESETS.shell.accentColor, color: AGENT_PRESETS.shell.accentColor }}
        >
          + Shell
        </button>
      </div>
    </div>
  )
}
