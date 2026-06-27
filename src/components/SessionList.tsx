/**
 * SessionList — Sidebar showing all sessions with live status indicators.
 *
 * Features:
 * - Color-coded status dots (pulsing for active/needs-input)
 * - Unread output badges
 * - Click to switch sessions
 * - Archive button (×) moves to archived section without killing
 * - Collapsible archived section with restore option
 * - Quick-create buttons for preset agents
 */

import { useState } from 'react'
import type { SessionMeta, SessionStatus } from '../shared/protocol'
import { AGENT_PRESETS } from '../shared/protocol'

interface SessionListProps {
  sessions: SessionMeta[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onCreate: (preset: string) => void
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

export function SessionList({ sessions, activeSessionId, onSelect, onClose, onArchive, onUnarchive, onCreate }: SessionListProps) {
  const [showArchived, setShowArchived] = useState(false)

  const activeSessions = sessions.filter(s => !s.archived)
  const archivedSessions = sessions.filter(s => s.archived)
  const needsAttention = activeSessions.filter(s =>
    s.status === 'needs-input' || s.hasUnreadOutput
  ).length

  return (
    <div className="session-list">
      <div className="session-list-header">
        <h2>Sessions</h2>
        {needsAttention > 0 && (
          <span className="attention-badge">{needsAttention}</span>
        )}
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
                <div className="session-summary">{session.summary}</div>
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

        {activeSessions.length === 0 && archivedSessions.length === 0 && (
          <div className="empty-state">
            No sessions yet.
            <br />
            Create one below ↓
          </div>
        )}
      </div>

      {/* Archived section */}
      {archivedSessions.length > 0 && (
        <div className="archived-section">
          <button
            className="archived-toggle"
            onClick={() => setShowArchived(!showArchived)}
          >
            <span className={`archived-arrow ${showArchived ? 'open' : ''}`}>▶</span>
            Archived ({archivedSessions.length})
          </button>
          {showArchived && (
            <div className="archived-items">
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
                </div>
              ))}
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
