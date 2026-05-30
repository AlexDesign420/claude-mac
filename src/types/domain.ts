export type ProjectStatus = 'active' | 'paused' | 'ended' | 'error'
export type SessionStatus = 'pending' | 'diagnosing' | 'spawning' | 'running' | 'active' | 'paused' | 'ended' | 'failed' | 'error'
export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'unknown'
export type SessionMode = 'safe' | 'auto' | 'no_confirm' | 'full_auto'
export type ChatSurfaceMode = 'terminal' | 'chat' | 'logs'
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
export type NavItem =
  | 'projects'
  | 'chat'
  | 'agents'
  | 'activity'
  | 'tools'
  | 'usage'
  | 'logs'
  | 'settings'

export interface ProjectRecord {
  id: string
  name: string
  path: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

export interface SessionRecord {
  id: string
  projectId: string
  label: string
  status: SessionStatus
  mode: SessionMode
  startedAt: string
  lastActivityAt: string
  shell?: string | null
  cwd?: string | null
  command?: string | null
  recoveryKey?: string | null
  preferred?: number
}

export interface RawLogRecord {
  id: string
  sessionId: string
  projectId: string
  direction: 'input' | 'output' | 'event' | 'error'
  chunk: string
  createdAt: string
}

export interface AgentRecord {
  id: string
  name: string
  sessionId: string
  projectId: string
  status: AgentStatus
  startedAt: string
  lastActivityAt: string
  currentTask: string
  currentTool?: string | null
  agentType?: string | null
  transcriptPath?: string | null
  lastAssistantMessage?: string | null
  tokenEstimate: number
  sourceLogId?: string | null
}

export interface HookEventRecord {
  id: string
  sessionId: string
  projectId: string
  hookEventName: string
  toolName?: string | null
  agentId?: string | null
  parentAgentId?: string | null
  agentType?: string | null
  transcriptPath?: string | null
  agentTranscriptPath?: string | null
  cwd?: string | null
  permissionMode?: string | null
  timestamp: string
  createdAt?: string | null
  rawJson: string
}

export interface ToolCallRecord {
  id: string
  sessionId: string
  projectId: string
  agentId?: string | null
  toolName: string
  status: 'running' | 'completed' | 'failed' | 'unknown'
  inputSummary?: string | null
  outputSummary?: string | null
  startedAt: string
  completedAt?: string | null
  durationMs?: number | null
  error?: string | null
  rawEventId?: string | null
  filePath?: string | null
}

export interface SubagentRecord {
  id: string
  sessionId: string
  projectId: string
  parentAgentId?: string | null
  agentType?: string | null
  name: string
  status: AgentStatus
  taskPrompt?: string | null
  transcriptPath?: string | null
  agentTranscriptPath?: string | null
  lastAssistantMessage?: string | null
  startedAt: string
  lastActivityAt: string
  completedAt?: string | null
  tokenEstimate: number
  error?: string | null
  rawEventId?: string | null
}

export interface NotificationRecord {
  id: string
  sessionId: string
  projectId: string
  agentId?: string | null
  level: string
  message: string
  rawEventId?: string | null
  createdAt: string
}

export interface UsageSnapshot {
  id: string
  sessionId: string
  projectId: string
  totalTokens: number
  tokensPerMinute: number
  estimated: boolean
  capturedAt: string
  model?: string | null
  provider?: string | null
  contextWindow?: number | null
  sourceLogId?: string | null
}

export interface ModePreset {
  id: string
  mode: SessionMode
  label: string
  startCommand: string
  startArgs: string[]
  env: Record<string, string>
  description: string
  enabled: boolean
  updatedAt?: string
}

export interface SettingsRecord {
  projectRoot: string
  defaultMode: SessionMode
  theme: 'dark' | 'light' | 'system'
  sqlitePath: string
  loggingEnabled: boolean
  parserRules: string
  autostartEnabled: boolean
  sessionRecovery: boolean
  allowMultipleSessionsPerProject: boolean
  autoStatusPollEnabled: boolean
  autoStatusPollMinutes: number
}

export interface RuntimeInfo {
  running: boolean
  port: number | null
  hookPort?: number | null
  dataDir: string
  launchMode: string
}

export interface HookStatus {
  running: boolean
  port: number | null
  url: string
  statusUrl: string
  eventsReceived: number
  supportedEvents: string[]
  toolMatcher: string
}

export interface DiagnosticResult {
  ok?: boolean
  kind?: string
  message?: string
  shell?: string
  home?: string
  user?: string
  cwd?: string
  path?: string
  which?: string
  type?: string
  typeResult?: string
  commandV?: string
  alias?: string
  whence?: string
  shellFiles?: Array<{ name: string; path: string; exists: boolean }>
  candidates?: Array<{ path: string; exists: boolean; executable: boolean }>
  resolution?: string
  finalStartCommand?: string
  finalPtyCommand?: string
  stdout?: string
  stderr?: string
  details?: string
  exitCode?: number
  nodeBinary?: string
  nodeVersion?: string
  platform?: string
  arch?: string
  appDir?: string
  resourceDir?: string
  sidecarRoot?: string
  nodeModules?: Record<string, unknown>
  betterSqlite3?: Record<string, unknown>
  nodePty?: Record<string, unknown>
  ws?: Record<string, unknown>
  uuid?: Record<string, unknown>
  spawnHelper?: Record<string, unknown>
  diagnostics?: Record<string, unknown>
  nativeRuntimeStatus?: Record<string, unknown>
  suggestion?: string
  command?: string
}

export interface RuntimeEventRecord {
  eventType: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface AppSnapshot {
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  agents: AgentRecord[]
  usageSnapshots: UsageSnapshot[]
  hookEvents: HookEventRecord[]
  toolCalls: ToolCallRecord[]
  subagents: SubagentRecord[]
  notifications: NotificationRecord[]
  hookStatus: HookStatus
  rawLogs: RawLogRecord[]
  settings: SettingsRecord
  commandPresets: ModePreset[]
}

export interface RuntimeEnvelope {
  type:
    | 'bootstrap'
    | 'projects_updated'
    | 'sessions_updated'
    | 'agents_updated'
    | 'usage_updated'
    | 'hook_events_updated'
    | 'tool_calls_updated'
    | 'subagents_updated'
    | 'notifications_updated'
    | 'hook_status_updated'
    | 'hooks_install_preview'
    | 'hooks_install_result'
    | 'token_update'
    | 'logs_updated'
    | 'settings_updated'
    | 'command_presets_updated'
    | 'pty_output'
    | 'agent_detected'
    | 'session_selected'
    | 'session_conflict'
    | 'connection_state'
    | 'diagnostic_result'
    | 'runtime_event'
    | 'start_progress'
    | 'session_lifecycle'
    | 'error'
  payload: unknown
}

export interface RuntimeErrorPayload {
  message: string
  shell?: string
  path?: string
  cwd?: string
  typeResult?: string
  suggestion?: string
  details?: string
  home?: string
  user?: string
  which?: string
  commandV?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  shellFiles?: DiagnosticResult['shellFiles']
  candidates?: DiagnosticResult['candidates']
  finalStartCommand?: string
  finalPtyCommand?: string
}

export interface CreateProjectPayload {
  name: string
  path: string
}

export type SettingsUpdate = Partial<SettingsRecord>
