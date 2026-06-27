/**
 * Shared protocol types — used by both the React frontend and the Node.js backend.
 * This is the single source of truth for the WebSocket message format.
 */

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

export type ClientMessage =
  | CreateSessionMessage
  | InputMessage
  | ResizeMessage
  | CloseSessionMessage
  | ArchiveSessionMessage
  | UnarchiveSessionMessage
  | SwitchSessionMessage
  | TranscribeMessage

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
      /\$\s*$/,                          // shell prompt
      /#\s*$/,                           // root prompt
    ],
    workingPatterns: [],
  },
}
