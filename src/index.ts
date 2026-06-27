/**
 * Agent Multiplexer — Library entry point.
 *
 * Export the main component and all sub-components for flexible embedding.
 *
 * Usage:
 *   import { AgentMultiplexer } from 'agent-multiplexer'
 *   <AgentMultiplexer serverUrl="ws://localhost:3461/ws" />
 *
 * Or import individual pieces:
 *   import { SessionList, TerminalPane } from 'agent-multiplexer'
 */

export { AgentMultiplexer } from './index.tsx'
export type { AgentMultiplexerProps } from './index.tsx'
export { SessionList } from './components/SessionList'
export { TerminalPane } from './components/TerminalPane'
export { VoiceInput } from './components/VoiceInput'
export { useAgentMux, outputStore, onTranscriptionResult } from './hooks/useAgentMux'
export * from './shared/protocol'
