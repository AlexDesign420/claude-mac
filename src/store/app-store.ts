import { toast } from 'sonner'
import { create } from 'zustand'

import { runtimeClient } from '@/lib/runtime-client'
import { tauriInvoke } from '@/lib/tauri'
import type {
  AgentRecord,
  AppSnapshot,
  ChatSurfaceMode,
  ConnectionStatus,
  CreateProjectPayload,
  DiagnosticResult,
  HookEventRecord,
  HookStatus,
  ModePreset,
  NavItem,
  NotificationRecord,
  ProjectRecord,
  RawLogRecord,
  RuntimeEnvelope,
  RuntimeErrorPayload,
  RuntimeInfo,
  RuntimeEventRecord,
  SessionRecord,
  SettingsRecord,
  SettingsUpdate,
  SubagentRecord,
  ToolCallRecord,
  UsageSnapshot,
} from '@/types/domain'

const defaultSettings: SettingsRecord = {
  projectRoot: '',
  defaultMode: 'safe',
  theme: 'system',
  sqlitePath: '',
  loggingEnabled: true,
  parserRules: 'default',
  autostartEnabled: false,
  sessionRecovery: true,
  allowMultipleSessionsPerProject: false,
  autoStatusPollEnabled: false,
  autoStatusPollMinutes: 5,
}

interface AppState {
  nav: NavItem
  chatSurfaceMode: ChatSurfaceMode
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
  commandPresets: ModePreset[]
  diagnostics: {
    latest: DiagnosticResult | null
    history: DiagnosticResult[]
    panelOpen: boolean
  }
  runtimeEvents: RuntimeEventRecord[]
  startStatus: string
  settings: SettingsRecord
  connection: {
    status: ConnectionStatus
    lastError: RuntimeErrorPayload | null
  }
  runtime: RuntimeInfo
  selectedProjectId: string | null
  selectedSessionId: string | null
  setNav: (nav: NavItem) => void
  setChatSurfaceMode: (mode: ChatSurfaceMode) => void
  setSelectedProjectId: (projectId: string | null) => void
  setSelectedSessionId: (sessionId: string | null) => void
  setRuntime: (runtime: RuntimeInfo) => void
  setConnectionStatus: (status: ConnectionStatus) => void
  applyEnvelope: (envelope: RuntimeEnvelope) => void
  createProject: (payload: CreateProjectPayload) => Promise<void>
  startSession: (projectId: string, forceNewSession?: boolean) => Promise<void>
  stopSession: (sessionId: string) => Promise<void>
  restartSession: (sessionId: string) => Promise<void>
  sendInput: (sessionId: string, input: string) => Promise<void>
  updateSettings: (payload: SettingsUpdate) => Promise<void>
  updateCommandPreset: (payload: ModePreset) => Promise<void>
  createProjectAndStart: (payload: CreateProjectPayload) => Promise<void>
  installProjectHooks: (projectId?: string) => Promise<void>
  refreshHookStatus: () => Promise<void>
  requestStatusPoll: (sessionId?: string) => Promise<void>
  diagnoseRuntime: (projectId?: string) => Promise<void>
  diagnoseNativeRuntime: () => Promise<void>
  restartSidecar: () => Promise<void>
  repairDatabase: () => Promise<void>
  resetDatabaseWithBackup: () => Promise<void>
  diagnoseClaudestart: (projectId?: string) => Promise<void>
  testStartCommand: (mode?: string, projectId?: string) => Promise<void>
  openDiagnostics: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  nav: 'projects',
  chatSurfaceMode: 'terminal',
  projects: [],
  sessions: [],
  agents: [],
  usageSnapshots: [],
  hookEvents: [],
  toolCalls: [],
  subagents: [],
  notifications: [],
  hookStatus: {
    running: false,
    port: null,
    url: '',
    statusUrl: '',
    eventsReceived: 0,
    supportedEvents: [],
    toolMatcher: '',
  },
  rawLogs: [],
  commandPresets: [],
  diagnostics: {
    latest: null,
    history: [],
    panelOpen: false,
  },
  runtimeEvents: [],
  startStatus: 'Sidecar startet',
  settings: defaultSettings,
  connection: { status: 'connecting', lastError: null },
  runtime: { running: false, port: null, hookPort: null, dataDir: '', launchMode: 'pending' },
  selectedProjectId: null,
  selectedSessionId: null,
  setNav: (nav) => set({ nav }),
  setChatSurfaceMode: (chatSurfaceMode) => set({ chatSurfaceMode }),
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  setRuntime: (runtime) => set({ runtime }),
  setConnectionStatus: (status) =>
    set((state) => ({
      connection: {
        ...state.connection,
        status,
      },
    })),
  applyEnvelope: (envelope) => {
    if (envelope.type === 'error') {
      const payload = envelope.payload as RuntimeErrorPayload
      set((state) => ({
        connection: {
          ...state.connection,
          status: 'error',
          lastError: payload,
        },
        diagnostics: {
          ...state.diagnostics,
          latest: payload,
          history: [payload, ...state.diagnostics.history].slice(0, 20),
          panelOpen: true,
        },
        startStatus: 'Fehler',
        nav: state.nav === 'chat' ? 'chat' : 'settings',
      }))
      toast.error(payload.message)
      return
    }

    if (envelope.type === 'bootstrap') {
      const payload = envelope.payload as AppSnapshot
      set({
        projects: payload.projects ?? [],
        sessions: payload.sessions ?? [],
        agents: payload.agents ?? [],
        usageSnapshots: payload.usageSnapshots ?? [],
        hookEvents: payload.hookEvents ?? [],
        toolCalls: payload.toolCalls ?? [],
        subagents: payload.subagents ?? [],
        notifications: payload.notifications ?? [],
        hookStatus: payload.hookStatus ?? get().hookStatus,
        rawLogs: payload.rawLogs ?? [],
        settings: payload.settings ?? defaultSettings,
        commandPresets: payload.commandPresets ?? [],
        connection: { status: 'connected', lastError: null },
        startStatus: 'WebSocket verbunden',
        selectedProjectId: get().selectedProjectId ?? payload.projects?.[0]?.id ?? null,
        selectedSessionId: get().selectedSessionId ?? payload.sessions?.[0]?.id ?? null,
      })
      return
    }

    if (envelope.type === 'projects_updated') {
      const projects = envelope.payload as ProjectRecord[]
      set((state) => ({
        projects,
        startStatus: projects.length ? 'Projekt gespeichert' : state.startStatus,
        selectedProjectId: state.selectedProjectId ?? projects[0]?.id ?? null,
      }))
      return
    }

    if (envelope.type === 'sessions_updated') {
      const sessions = envelope.payload as SessionRecord[]
      set((state) => ({
        sessions,
        startStatus: sessions.some((session) => session.status === 'running' || session.status === 'active')
          ? 'Claude laeuft'
          : sessions.some((session) => session.status === 'failed' || session.status === 'error')
            ? 'Fehler'
            : sessions.length
              ? 'Claude beendet'
              : state.startStatus,
        selectedSessionId: state.selectedSessionId ?? sessions[0]?.id ?? null,
      }))
      return
    }

    if (envelope.type === 'agents_updated') {
      set({ agents: envelope.payload as AgentRecord[] })
      return
    }

    if (envelope.type === 'usage_updated') {
      set({ usageSnapshots: envelope.payload as UsageSnapshot[] })
      return
    }

    if (envelope.type === 'hook_events_updated') {
      set({ hookEvents: envelope.payload as HookEventRecord[] })
      return
    }

    if (envelope.type === 'tool_calls_updated') {
      set({ toolCalls: envelope.payload as ToolCallRecord[] })
      return
    }

    if (envelope.type === 'subagents_updated') {
      set({ subagents: envelope.payload as SubagentRecord[] })
      return
    }

    if (envelope.type === 'notifications_updated') {
      set({ notifications: envelope.payload as NotificationRecord[] })
      return
    }

    if (envelope.type === 'hook_status_updated') {
      set({ hookStatus: (envelope.payload as HookStatus) ?? get().hookStatus })
      return
    }

    if (envelope.type === 'hooks_install_result') {
      const payload = envelope.payload as { ok?: boolean; settingsPath?: string; hookUrl?: string }
      toast.success(`Claude Hooks installiert: ${payload.settingsPath ?? payload.hookUrl ?? 'Projekt'}`)
      return
    }

    if (envelope.type === 'logs_updated') {
      set({ rawLogs: envelope.payload as RawLogRecord[] })
      return
    }

    if (envelope.type === 'settings_updated') {
      set({ settings: envelope.payload as SettingsRecord })
      return
    }

    if (envelope.type === 'command_presets_updated') {
      set({ commandPresets: envelope.payload as ModePreset[] })
      return
    }

    if (envelope.type === 'session_selected') {
      const payload = envelope.payload as { sessionId: string | null; projectId: string | null }
      set({
        selectedSessionId: payload.sessionId,
        selectedProjectId: payload.projectId,
        nav: 'chat',
        startStatus: 'Claude laeuft',
      })
      return
    }

    if (envelope.type === 'session_conflict') {
      const payload = envelope.payload as { message: string; sessionId: string; projectId: string }
      set({
        selectedSessionId: payload.sessionId,
        selectedProjectId: payload.projectId,
        nav: 'chat',
      })
      toast.message(payload.message)
      return
    }

    if (envelope.type === 'agent_detected') {
      const payload = envelope.payload as AgentRecord
      toast.success(`Neuer Agent erkannt: ${payload.name}`)
      return
    }

    if (envelope.type === 'connection_state') {
      const payload = envelope.payload as { status: ConnectionStatus }
      set((state) => ({
        connection: {
          ...state.connection,
          status: payload.status,
        },
      }))
      return
    }

    if (envelope.type === 'diagnostic_result') {
      const payload = envelope.payload as { kind: string; result: DiagnosticResult }
      const result = { ...payload.result, kind: payload.kind }
      set((state) => ({
        diagnostics: {
          latest: result,
          history: [result, ...state.diagnostics.history].slice(0, 20),
          panelOpen: true,
        },
        startStatus: result.ok ? state.startStatus : 'Fehler',
      }))
      return
    }

    if (envelope.type === 'runtime_event') {
      const payload = envelope.payload as RuntimeEventRecord
      set((state) => ({
        runtimeEvents: [payload, ...state.runtimeEvents].slice(0, 80),
      }))
      return
    }

    if (envelope.type === 'start_progress') {
      const payload = envelope.payload as { step?: string; message?: string }
      const labels: Record<string, string> = {
        request_received: 'Start-Anfrage empfangen',
        project_checked: 'Projekt geprüft',
        claudestart_diagnosing: 'claudestart Diagnose läuft',
        claudestart_found: 'claudestart gefunden',
        pty_spawning: 'PTY wird gestartet',
        pty_spawn_success: 'Claude PTY läuft',
        pty_spawn_failed: 'PTY-Start fehlgeschlagen',
        failed: 'Fehler',
      }
      set({ startStatus: payload.message ?? labels[payload.step ?? ''] ?? payload.step ?? 'Start läuft' })
      return
    }

    if (envelope.type === 'session_lifecycle') {
      const payload = envelope.payload as { status: string }
      const labels: Record<string, string> = {
        pending: 'Session wird gestartet',
        diagnosing: 'Diagnose laeuft',
        spawning: 'Claude wird gestartet',
        running: 'Claude laeuft',
        failed: 'Fehler',
        ended: 'Claude beendet',
      }
      set({ startStatus: labels[payload.status] ?? payload.status })
    }
  },
  createProject: async (payload) => {
    const result = runtimeClient.createProject(payload)
    if (result.queued) toast.message(result.error)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  startSession: async (projectId, forceNewSession = false) => {
    const state = get()
    set({
      startStatus: 'Start wird an den Sidecar gesendet',
      selectedProjectId: projectId,
      nav: 'chat',
    })
    const result = runtimeClient.startSession(projectId, state.settings.defaultMode, forceNewSession)
    if (result.queued) toast.message(result.error)
    if (!result.ok && !result.queued) {
      set({ startStatus: 'Fehler' })
      toast.error(result.error)
    }
  },
  stopSession: async (sessionId) => {
    const result = runtimeClient.stopSession(sessionId)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  restartSession: async (sessionId) => {
    set({ startStatus: 'Session wird gestartet' })
    const result = runtimeClient.restartSession(sessionId)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  sendInput: async (sessionId, input) => {
    const result = runtimeClient.sendInput(sessionId, input)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  updateSettings: async (payload) => {
    set((state) => ({ settings: { ...state.settings, ...payload } }))
    const result = runtimeClient.updateSettings(payload)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  updateCommandPreset: async (payload) => {
    set((state) => ({
      commandPresets: state.commandPresets.map((preset) => (preset.mode === payload.mode ? payload : preset)),
    }))
    const result = runtimeClient.updateCommandPreset(payload)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  createProjectAndStart: async (payload) => {
    set({ startStatus: 'Projekt gespeichert' })
    const state = get()
    const result = runtimeClient.createProjectAndStart({
      ...payload,
      mode: state.settings.defaultMode,
    })
    if (result.queued) toast.message(result.error)
    if (!result.ok && !result.queued) {
      set({ startStatus: 'Fehler' })
      toast.error(result.error)
    }
  },
  installProjectHooks: async (projectId) => {
    const targetProjectId = projectId ?? get().selectedProjectId
    if (!targetProjectId) {
      toast.error('Bitte zuerst ein Projekt auswählen.')
      return
    }
    const result = runtimeClient.installProjectHooks(targetProjectId)
    if (result.queued) toast.message(result.error)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  refreshHookStatus: async () => {
    const result = runtimeClient.hooksStatus()
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  requestStatusPoll: async (sessionId) => {
    const targetSessionId = sessionId ?? get().selectedSessionId
    if (!targetSessionId) {
      toast.error('Keine Session für /status ausgewählt.')
      return
    }
    const result = runtimeClient.sendInput(targetSessionId, '/status')
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  diagnoseRuntime: async (projectId) => {
    const result = runtimeClient.diagnoseRuntime(projectId ?? get().selectedProjectId ?? undefined)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  diagnoseNativeRuntime: async () => {
    const result = runtimeClient.diagnoseNativeRuntime()
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  restartSidecar: async () => {
    set({ startStatus: 'Sidecar wird neu gestartet', connection: { status: 'connecting', lastError: null } })
    runtimeClient.close()
    try {
      const runtime = await tauriInvoke<RuntimeInfo>('restart_sidecar')
      set({ runtime, startStatus: 'Sidecar neu gestartet' })
      runtimeClient.connect(runtime)
      toast.success('Sidecar wurde neu gestartet.')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        connection: {
          ...state.connection,
          status: 'error',
          lastError: {
            message: 'Sidecar konnte nicht neu gestartet werden.',
            details: message,
            suggestion: 'Oeffne die Diagnose und pruefe Sidecar-Pfade, Bootstrap-Events und native Module.',
          },
        },
        diagnostics: {
          ...state.diagnostics,
          latest: {
            ok: false,
            message: 'Sidecar konnte nicht neu gestartet werden.',
            details: message,
          },
          panelOpen: true,
        },
        startStatus: 'Fehler',
      }))
      toast.error('Sidecar konnte nicht neu gestartet werden.')
    }
  },
  repairDatabase: async () => {
    const result = runtimeClient.repairDatabase()
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  resetDatabaseWithBackup: async () => {
    const result = runtimeClient.resetDatabaseWithBackup()
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  diagnoseClaudestart: async (projectId) => {
    const state = get()
    const result = runtimeClient.diagnoseClaudestart(projectId ?? state.selectedProjectId ?? undefined, state.settings.defaultMode)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  testStartCommand: async (mode, projectId) => {
    const state = get()
    const result = runtimeClient.testPtyStart(projectId ?? state.selectedProjectId ?? undefined, mode ?? state.settings.defaultMode)
    if (!result.ok && !result.queued) toast.error(result.error)
  },
  openDiagnostics: () =>
    set((state) => ({
      diagnostics: {
        ...state.diagnostics,
        panelOpen: true,
      },
      nav: 'settings',
    })),
}))
