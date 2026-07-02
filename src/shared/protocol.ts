/**
 * Shared protocol types — used by both the React frontend and the Node.js backend.
 * This is the single source of truth for the WebSocket message format.
 */

// ── Structured Agent Events ────────────────────────────────────
// Adapters tail each agent's own persistence (Claude JSONL, Hermes SQLite)
// and emit these typed events. They flow over the WebSocket alongside raw
// terminal output, giving the frontend structured visibility into what the
// agent is actually doing — without regex-guessing from painted terminal text.

export type AgentEventKind =
  | 'thinking'      // Agent is reasoning (extended thinking)
  | 'text'          // Assistant message text chunk
  | 'tool-call'     // Agent invoked a tool
  | 'tool-result'   // Tool returned a result
  | 'usage'         // Token usage update
  | 'turn-start'    // New user→assistant turn began
  | 'turn-end'      // Turn completed
  | 'thread-sent'   // Delegation: task handed off to another session
  | 'thread-received' // Delegation: result received back from another session

export interface AgentEvent {
  /** Unique event ID (for dedup on reconnect) */
  id: string
  /** Which kind of event */
  kind: AgentEventKind
  /** ISO timestamp */
  timestamp: string
  /** For tool-call: the tool name (Read, Bash, terminal, etc.) */
  toolName?: string
  /** For tool-call/tool-result: a short preview of the input or output */
  detail?: string
  /** For usage: token counts */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
  }
  /** For text/thinking: a preview of the content (first ~120 chars) */
  preview?: string
  /** For tool-call: a unique ID to match with the tool-result */
  toolCallId?: string
  /** For thread-sent/thread-received: the name of the other session */
  threadPeerName?: string
  /** For thread-sent/thread-received: the delegation ID linking the pair */
  threadId?: string
}

export interface AgentEventMessage {
  type: 'agent-event'
  sessionId: string
  event: AgentEvent
}

// ── Session Status ──────────────────────────────────────────────

export type SessionStatus =
  | 'idle'        // Process alive, waiting for input
  | 'working'     // Actively producing output
  | 'needs-input' // Detected a prompt/question awaiting user response
  | 'completed'   // Task finished, process may have exited
  | 'failed'      // Process exited with error
  | 'stopped'     // Manually stopped by user
  | 'detached'    // Running but not actively viewed

// ── Session Metadata ────────────────────────────────────────────

export interface SessionMeta {
  id: string
  name: string
  status: SessionStatus
  /** What type of agent is running: 'claude', 'hermes', 'shell', or custom */
  agentType: string
  /** Working directory the session was spawned in */
  cwd: string
  /** ISO timestamp of creation */
  createdAt: string
  /** ISO timestamp of last activity */
  lastActivity: string
  /** Whether new output has arrived since the user last viewed this session */
  hasUnreadOutput: boolean
  /** Human-readable summary of recent activity (for the sidebar) */
  summary: string
  /** Accent color for this session type (for UI badges) */
  accentColor: string
  /** True when the user archived this session (hidden from active list) */
  archived: boolean
  /** Recent terminal output buffer (scrollback for reconnect replay) */
  recentOutput?: string
  /** Structured activity summary from the agent adapter (null for shells/unknown) */
  structuredActivity?: StructuredActivity
}

/** Structured activity info derived from agent persistence, not regex guessing */
export interface StructuredActivity {
  /** Current or last completed tool name */
  lastToolName: string | null
  /** Number of tool calls in this session */
  toolCallCount: number
  /** Number of turns (user→assistant exchanges) */
  turnCount: number
  /** Cumulative token usage */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Whether structured events are flowing (adapter active) */
  active: boolean
}

// ── Server → Client Messages ────────────────────────────────────

export interface OutputMessage {
  type: 'output'
  sessionId: string
  /** Raw terminal data (may include ANSI escape codes) */
  data: string
}

export interface SessionListMessage {
  type: 'sessions'
  sessions: SessionMeta[]
}

export interface StatusChangeMessage {
  type: 'status-change'
  sessionId: string
  status: SessionStatus
  summary: string
}

export interface SessionCreatedMessage {
  type: 'session-created'
  session: SessionMeta
}

export interface SessionClosedMessage {
  type: 'session-closed'
  sessionId: string
  exitCode: number
}

export interface AlertMessage {
  type: 'alert'
  sessionId: string
  message: string
  level: 'info' | 'warning' | 'error'
}

export interface TranscriptionResultMessage {
  type: 'transcription'
  /** Matches the requestId from TranscribeMessage */
  requestId: string
  /** Transcribed text */
  text: string
  /** Transcription time in seconds */
  elapsed: number
  /** Error message if transcription failed */
  error?: string
}

export type ServerMessage =
  | OutputMessage
  | SessionListMessage
  | StatusChangeMessage
  | SessionCreatedMessage
  | SessionClosedMessage
  | AlertMessage
  | TranscriptionResultMessage
  | AgentEventMessage
  | WorkspaceListMessage
  | DirListingMessage
  | SettingsMessage
  | RefineResultMessage
  | DelegationResultMessage

// ── Client → Server Messages ────────────────────────────────────

export interface CreateSessionMessage {
  type: 'create-session'
  name: string
  /** Command to run, e.g. 'claude', 'hermes', 'bash' */
  command: string
  /** Arguments to pass to the command */
  args?: string[]
  /** Working directory */
  cwd?: string
  /** Agent type for display */
  agentType?: string
  /** LLM instructions / system prompt (agent-type-specific injection) */
  instructions?: string
}

export interface InputMessage {
  type: 'input'
  sessionId: string
  data: string
}

export interface ResizeMessage {
  type: 'resize'
  sessionId: string
  cols: number
  rows: number
}

export interface CloseSessionMessage {
  type: 'close-session'
  sessionId: string
}

export interface ArchiveSessionMessage {
  type: 'archive-session'
  sessionId: string
}

export interface UnarchiveSessionMessage {
  type: 'unarchive-session'
  sessionId: string
}

export interface DeleteSessionMessage {
  type: 'delete-session'
  sessionId: string
}

export interface SwitchSessionMessage {
  type: 'switch-session'
  sessionId: string
}

// ── Voice / Whisper Messages ────────────────────────────────────

export interface TranscribeMessage {
  type: 'transcribe'
  /** Request ID to match response */
  requestId: string
  /** Audio data as base64-encoded bytes (webm/opus from MediaRecorder) */
  audio: string
  /** MIME type of the audio */
  mimeType: string
}

// ── Delegation Messages ─────────────────────────────────────────

export interface DelegateMessage {
  type: 'delegate'
  /** Session that initiated the delegation (the "from" session) */
  fromSessionId: string
  /** Session that will receive the task (the "to" session) */
  toSessionId: string
  /** The task text to send to the target agent */
  task: string
}

export interface DelegationResultMessage {
  type: 'delegation-result'
  /** Unique delegation ID linking the sent/received pair */
  delegationId: string
  /** Session that initiated */
  fromSessionId: string
  /** Session that completed the task */
  toSessionId: string
  /** The response text from the target agent */
  result: string
  /** Error message if the delegation failed */
  error?: string
}

export type ClientMessage =
  | CreateSessionMessage
  | InputMessage
  | ResizeMessage
  | CloseSessionMessage
  | ArchiveSessionMessage
  | UnarchiveSessionMessage
  | SwitchSessionMessage
  | DeleteSessionMessage
  | TranscribeMessage
  | CreateWorkspaceMessage
  | UpdateWorkspaceMessage
  | DeleteWorkspaceMessage
  | ArchiveWorkspaceMessage
  | UnarchiveWorkspaceMessage
  | ListDirMessage
  | UpdateSettingsMessage
  | RefineMessage
  | DelegateMessage

// ── Workspaces ──────────────────────────────────────────────────

export interface Workspace {
  /** Unique ID (8-char hex) */
  id: string
  /** Display name, e.g. "HomeHub", "Scottish Jobs" */
  name: string
  /** Agent preset key: 'claude' | 'hermes' | 'shell' */
  agentType: string
  /** Working directory to start the session in */
  cwd: string
  /** Optional extra args to pass to the command */
  args?: string[]
  /** Icon emoji for the button */
  icon?: string
  /** LLM instructions / system prompt prepended on session launch */
  instructions?: string
  /** True when archived (hidden from workspace list) */
  archived?: boolean
}

// ── Workspace Messages (Client → Server) ────────────────────────

export interface CreateWorkspaceMessage {
  type: 'create-workspace'
  name: string
  agentType: string
  cwd: string
  args?: string[]
  icon?: string
  instructions?: string
}

export interface UpdateWorkspaceMessage {
  type: 'update-workspace'
  id: string
  name?: string
  agentType?: string
  cwd?: string
  args?: string[]
  icon?: string
  instructions?: string
}

export interface DeleteWorkspaceMessage {
  type: 'delete-workspace'
  id: string
}

export interface ArchiveWorkspaceMessage {
  type: 'archive-workspace'
  id: string
}

export interface UnarchiveWorkspaceMessage {
  type: 'unarchive-workspace'
  id: string
}

// ── Settings ────────────────────────────────────────────────────

export interface AppSettings {
  /** OpenRouter API key for LLM-powered features */
  openrouterApiKey: string
  /** Model to use for speech refinement (default: auto-pick a fast free model) */
  refineModel: string
}

// ── Settings Messages (Client → Server) ─────────────────────────

export interface UpdateSettingsMessage {
  type: 'update-settings'
  settings: Partial<AppSettings>
}

// ── Settings Messages (Server → Client) ─────────────────────────

export interface SettingsMessage {
  type: 'settings'
  settings: AppSettings
}

// ── Refine Messages (Client → Server) ───────────────────────────

export interface RefineMessage {
  type: 'refine'
  requestId: string
  text: string
  /** The agent type context ('claude', 'hermes', 'shell') for tailored refinement */
  agentType?: string
}

// ── Refine Messages (Server → Client) ───────────────────────────

export interface RefineResultMessage {
  type: 'refine-result'
  requestId: string
  text: string
  error?: string
}

// ── Directory Listing ───────────────────────────────────────────

export interface ListDirMessage {
  type: 'list-dir'
  /** Directory to list, or empty for home */
  path?: string
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface DirListingMessage {
  type: 'dir-listing'
  /** The absolute path that was listed */
  path: string
  /** Parent directory path, or null if at root */
  parent: string | null
  entries: DirEntry[]
  /** Original request path (before ~ expansion) for client reference */
  requestedPath: string
}

// ── Workspace Messages (Server → Client) ────────────────────────

export interface WorkspaceListMessage {
  type: 'workspaces'
  workspaces: Workspace[]
}

// ── Agent Type Presets ──────────────────────────────────────────

export interface AgentPreset {
  command: string
  args?: string[]
  agentType: string
  accentColor: string
  /** Regex patterns that indicate the agent is waiting for user input */
  needsInputPatterns: RegExp[]
  /** Regex patterns that indicate the agent is actively working */
  workingPatterns: RegExp[]
}

export const AGENT_PRESETS: Record<string, AgentPreset> = {
  claude: {
    command: 'claude',
    agentType: 'claude',
    accentColor: '#D97757',
    needsInputPatterns: [
      /\?\s*$/,                          // ends with ?
      /\(y\/n\)/i,                       // y/n prompts
      /press.*enter/i,                   // "press enter to continue"
      /\[y\/n\]|--yes--no/i,             // bracketed y/n
      /^\s*>\s*$/,                       // bare prompt
    ],
    workingPatterns: [
      /✻|✽|●/,                           // Claude spinner characters
      /Editing|Searching|Reading|Running/, // Claude tool announcements
      /ESC to interrupt/i,
    ],
  },
  hermes: {
    command: 'hermes',
    agentType: 'hermes',
    accentColor: '#7C5CFC',
    needsInputPatterns: [
      /\?\s*$/,
      /waiting.*input/i,
      /clarif/i,
    ],
    workingPatterns: [
      /running|searching|executing/i,
    ],
  },
  shell: {
    command: typeof process !== 'undefined' ? (process.env.SHELL || 'bash') : 'bash',
    agentType: 'shell',
    accentColor: '#50C878',
    needsInputPatterns: [
      /\$\s*$/,                          // bash/sh prompt
      /#\s*$/,                           // root prompt
      /%\s*$/,                           // zsh prompt
    ],
    workingPatterns: [],
  },
}
