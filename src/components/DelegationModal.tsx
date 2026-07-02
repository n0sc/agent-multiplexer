/**
 * DelegationModal — Delegate a task from the active session to another.
 *
 * User picks a target session from the dropdown, types a task, and clicks delegate.
 * The task gets injected into the target agent's terminal; the result is captured
 * when the target agent's turn completes and injected back into the source.
 *
 * Inspired by the roadtrip planner's agent-to-agent handoff pattern, but adapted
 * for local PTY-based agents — the "thread" is our delegation plumbing, not an API.
 */

import { useState, useMemo } from 'react'
import type { SessionMeta } from '../shared/protocol'

interface DelegationModalProps {
  /** Session initiating the delegation */
  fromSession: SessionMeta
  /** All available sessions to delegate TO */
  sessions: SessionMeta[]
  onDelegate: (fromSessionId: string, toSessionId: string, task: string) => void
  onClose: () => void
}

export function DelegationModal({
  fromSession,
  sessions,
  onDelegate,
  onClose,
}: DelegationModalProps) {
  const [task, setTask] = useState('')
  const [targetId, setTargetId] = useState('')

  // Only show live sessions that aren't the source and aren't archived
  const candidates = useMemo(
    () => sessions.filter(s =>
      s.id !== fromSession.id &&
      !s.archived &&
      s.status !== 'detached' &&
      s.status !== 'completed' &&
      s.status !== 'failed' &&
      s.status !== 'stopped'
    ),
    [sessions, fromSession.id]
  )

  const handleSubmit = () => {
    if (!targetId || !task.trim()) return
    onDelegate(fromSession.id, targetId, task.trim())
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal delegation-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Delegate Task</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="delegation-from">
            <span className="delegation-label">From:</span>
            <span
              className="delegation-session-tag"
              style={{ borderLeftColor: fromSession.accentColor }}
            >
              {fromSession.name}
              <span className="delegation-agent-type">{fromSession.agentType}</span>
            </span>
          </div>

          <div className="delegation-to">
            <label className="delegation-label" htmlFor="delegate-target">
              To:
            </label>
            <select
              id="delegate-target"
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
              className="delegation-select"
            >
              <option value="">Select target session…</option>
              {candidates.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.agentType}) — {s.summary.slice(0, 30)}
                </option>
              ))}
            </select>
          </div>

          {candidates.length === 0 && (
            <div className="delegation-empty">
              No live sessions available to delegate to.
              <br />
              Create another session first.
            </div>
          )}

          <label className="delegation-label" htmlFor="delegate-task">
            Task:
          </label>
          <textarea
            id="delegate-task"
            className="delegation-task-input"
            value={task}
            onChange={e => setTask(e.target.value)}
            placeholder="Describe what you want the target agent to do…"
            rows={4}
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleSubmit()
              }
            }}
          />
          <div className="delegation-hint">⌘+Enter to delegate</div>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={!targetId || !task.trim()}
          >
            ↗ Delegate
          </button>
        </div>
      </div>
    </div>
  )
}
