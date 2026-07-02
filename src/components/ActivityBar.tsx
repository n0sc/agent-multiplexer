/**
 * ActivityBar — Structured activity sidebar shown below/above the terminal.
 *
 * Subscribes to agentEventStore for the active session and renders a live
 * activity timeline: tool calls, thinking indicators, token usage, and turn
 * markers. This is the structured view that complements the raw terminal —
 * inspired by the roadtrip planner's "right rail" concept.
 *
 * Falls back gracefully when no structured events are available (shells).
 */

import { useState, useEffect, useRef } from 'react'
import type { AgentEvent, StructuredActivity } from '../shared/protocol'
import { agentEventStore } from '../hooks/useAgentMux'

interface ActivityBarProps {
  sessionId: string | null
  activity: StructuredActivity | null | undefined
}

const EVENT_ICONS: Record<string, string> = {
  'thinking': '💭',
  'text': '💬',
  'tool-call': '🔧',
  'tool-result': '↩',
  'usage': '📊',
  'turn-start': '▶',
  'turn-end': '■',
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function ActivityBar({ sessionId, activity }: ActivityBarProps) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sessionId) {
      setEvents([])
      return
    }

    const unsubscribe = agentEventStore.subscribe(sessionId, (event) => {
      setEvents(prev => [...prev, event].slice(-50))
    })

    return () => {
      unsubscribe()
      setEvents([])
    }
  }, [sessionId])

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (scrollRef.current && expanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events, expanded])

  if (!sessionId) return null

  // No structured activity available (shell or adapter not started)
  const hasStructured = activity?.active || events.length > 0

  if (!hasStructured && !activity) {
    return (
      <div className="activity-bar empty">
        <span className="activity-label">No structured activity (raw terminal only)</span>
      </div>
    )
  }

  return (
    <div className={`activity-bar ${expanded ? 'expanded' : ''}`}>
      {/* ── Summary row (always visible) ── */}
      <div className="activity-summary" onClick={() => setExpanded(!expanded)}>
        <div className="activity-stats">
          {activity?.active && (
            <span className="activity-badge live" title="Structured events flowing">
              ● live
            </span>
          )}
          {activity && activity.toolCallCount > 0 && (
            <span className="activity-stat" title="Tool calls this session">
              🔧 {activity.toolCallCount}
            </span>
          )}
          {activity && activity.turnCount > 0 && (
            <span className="activity-stat" title="Turns (user→assistant)">
              🔄 {activity.turnCount}
            </span>
          )}
          {activity && (activity.inputTokens > 0 || activity.outputTokens > 0) && (
            <span className="activity-stat" title="Token usage">
              📊 {formatTokens(activity.inputTokens)}→{formatTokens(activity.outputTokens)}
              {activity.cacheReadTokens > 0 && (
                <span className="cache-tokens" title="Cache read tokens">
                  {' '}({formatTokens(activity.cacheReadTokens)} cached)
                </span>
              )}
            </span>
          )}
          {activity?.lastToolName && (
            <span className="activity-last-tool" title="Last tool used">
              {activity.lastToolName}
            </span>
          )}
        </div>
        <button
          className="activity-expand-btn"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(!expanded)
          }}
          title={expanded ? 'Collapse activity log' : 'Expand activity log'}
        >
          {expanded ? '▼' : '▲'}
        </button>
      </div>

      {/* ── Event timeline (expandable) ── */}
      {expanded && (
        <div className="activity-timeline" ref={scrollRef}>
          {events.length === 0 ? (
            <div className="activity-empty">Waiting for agent activity…</div>
          ) : (
            events.map((event, i) => (
              <div key={`${event.id}-${i}`} className={`activity-event activity-${event.kind}`}>
                <span className="activity-event-icon">
                  {EVENT_ICONS[event.kind] || '•'}
                </span>
                <span className="activity-event-time">
                  {new Date(event.timestamp).toLocaleTimeString('en-US', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <span className="activity-event-body">
                  {event.kind === 'tool-call' && (
                    <>
                      <span className="tool-name">{event.toolName}</span>
                      {event.detail && <span className="tool-detail"> {event.detail}</span>}
                    </>
                  )}
                  {event.kind === 'tool-result' && (
                    <>
                      <span className="tool-name">↳ result</span>
                      {event.detail && <span className="tool-detail"> {event.detail}</span>}
                    </>
                  )}
                  {event.kind === 'thinking' && (
                    <span className="thinking-preview">{event.preview || '…'}</span>
                  )}
                  {event.kind === 'text' && (
                    <span className="text-preview">{event.preview}</span>
                  )}
                  {event.kind === 'usage' && event.usage && (
                    <span className="usage-info">
                      in:{formatTokens(event.usage.inputTokens || 0)}
                      {' '}out:{formatTokens(event.usage.outputTokens || 0)}
                      {event.usage.cacheReadTokens ? ` cache:${formatTokens(event.usage.cacheReadTokens)}` : ''}
                    </span>
                  )}
                  {event.kind === 'turn-start' && <span className="turn-marker">user → agent</span>}
                  {event.kind === 'turn-end' && <span className="turn-marker">turn complete</span>}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
