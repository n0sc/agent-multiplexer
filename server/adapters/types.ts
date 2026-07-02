/**
 * Agent adapter interface.
 *
 * Each adapter tails an agent's structured persistence (JSONL files, SQLite DB,
 * etc.) and emits AgentEvents. This runs ALONGSIDE the PTY terminal stream —
 * the terminal shows raw output, the adapter provides structured metadata.
 *
 * The frontend gets accurate tool-call counts, token usage, thinking state,
 * and turn tracking — no regex guessing required.
 */

import type { AgentEvent, StructuredActivity } from '../../src/shared/protocol.js'

export interface AgentAdapter {
  /** Start watching the agent's persistence for this session */
  start(): void
  /** Stop watching and clean up file watchers / intervals */
  stop(): void
  /** Get the current structured activity summary */
  getActivity(): StructuredActivity
  /** Subscribe to events as they're emitted */
  onEvent(cb: (event: AgentEvent) => void): void
}

/** Callback type for adapter event subscriptions */
export type EventCallback = (event: AgentEvent) => void

/** Shared base providing the event-callback registry and activity tracking */
export abstract class BaseAdapter implements AgentAdapter {
  protected callbacks = new Set<EventCallback>()
  protected activity: StructuredActivity = {
    lastToolName: null,
    toolCallCount: 0,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    active: false,
  }

  onEvent(cb: EventCallback): void {
    this.callbacks.add(cb)
  }

  protected emit(event: AgentEvent): void {
    // Update aggregate activity from the event
    switch (event.kind) {
      case 'turn-start':
        this.activity.turnCount++
        break
      case 'tool-call':
        this.activity.toolCallCount++
        if (event.toolName) this.activity.lastToolName = event.toolName
        break
      case 'usage':
        this.activity.inputTokens += event.usage?.inputTokens ?? 0
        this.activity.outputTokens += event.usage?.outputTokens ?? 0
        this.activity.cacheReadTokens += event.usage?.cacheReadTokens ?? 0
        break
    }

    for (const cb of this.callbacks) cb(event)
  }

  getActivity(): StructuredActivity {
    return { ...this.activity }
  }

  abstract start(): void
  abstract stop(): void

  protected stopped = false
}
