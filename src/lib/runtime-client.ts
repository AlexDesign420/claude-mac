import type {
  ConnectionStatus,
  CreateProjectPayload,
  ModePreset,
  RuntimeEnvelope,
  RuntimeInfo,
  SettingsUpdate,
} from '@/types/domain'

type Listener = (envelope: RuntimeEnvelope) => void
type StatusListener = (status: ConnectionStatus) => void
type QueuedMessage = { type: string; payload: Record<string, unknown> }

export interface SendResult {
  ok: boolean
  queued: boolean
  error?: string
}

class RuntimeClient {
  private socket: WebSocket | null = null
  private listeners = new Set<Listener>()
  private statusListeners = new Set<StatusListener>()
  private url: string | null = null
  private reconnectAttempts = 0
  private manuallyClosed = false
  private queue: QueuedMessage[] = []

  connect(info: RuntimeInfo) {
    if (!info.port) {
      this.emitStatus('error')
      return
    }

    const nextUrl = `ws://127.0.0.1:${info.port}`
    if (this.socket && this.url === nextUrl && this.socket.readyState <= WebSocket.OPEN) {
      return
    }

    this.url = nextUrl
    this.manuallyClosed = false
    this.openSocket()
  }

  private openSocket() {
    if (!this.url) {
      return
    }

    this.emitStatus('connecting')
    this.socket?.close()
    this.socket = new WebSocket(this.url)

    this.socket.addEventListener('open', () => {
      this.reconnectAttempts = 0
      this.emitStatus('connected')
      this.flushQueue()
      this.bootstrap()
    })

    this.socket.addEventListener('message', (event) => {
      const envelope = JSON.parse(event.data) as RuntimeEnvelope
      if (envelope.type === 'connection_state') {
        const payload = envelope.payload as { status: ConnectionStatus }
        this.emitStatus(payload.status)
      }
      this.listeners.forEach((listener) => listener(envelope))
    })

    this.socket.addEventListener('close', () => {
      if (this.manuallyClosed) {
        return
      }
      this.emitStatus('disconnected')
      this.scheduleReconnect()
    })

    this.socket.addEventListener('error', () => {
      this.emitStatus('error')
    })
  }

  private scheduleReconnect() {
    if (!this.url) {
      return
    }
    const delay = Math.min(5000, 250 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    window.setTimeout(() => {
      if (!this.manuallyClosed) {
        this.openSocket()
      }
    }, delay)
  }

  private flushQueue() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    const messages = [...this.queue]
    this.queue = []
    for (const message of messages) {
      this.socket.send(JSON.stringify(message))
    }
  }

  private emitStatus(status: ConnectionStatus) {
    this.statusListeners.forEach((listener) => listener(status))
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onMessage(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    this.manuallyClosed = true
    this.socket?.close()
    this.socket = null
    this.url = null
    this.queue = []
  }

  send(type: string, payload: Record<string, unknown> = {}): SendResult {
    if (!this.url) {
      return {
        ok: false,
        queued: false,
        error: 'Sidecar WebSocket ist noch nicht initialisiert.',
      }
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.queue.push({ type, payload })
      return {
        ok: false,
        queued: true,
        error: 'WebSocket ist noch nicht verbunden. Aktion wurde vorgemerkt.',
      }
    }

    this.socket.send(JSON.stringify({ type, payload }))
    return { ok: true, queued: false }
  }

  bootstrap() {
    return this.send('bootstrap')
  }

  createProject(payload: CreateProjectPayload) {
    return this.send('create_project', payload as unknown as Record<string, unknown>)
  }

  createProjectAndStart(payload: CreateProjectPayload & { mode?: string; forceNewSession?: boolean }) {
    return this.send('create_project_and_start', payload as unknown as Record<string, unknown>)
  }

  startSession(projectId: string, mode?: string, forceNewSession = false) {
    return this.send('start_claude_session_verbose', {
      projectId,
      mode,
      forceNewSession,
    })
  }

  stopSession(sessionId: string) {
    return this.send('stop_session', { sessionId })
  }

  restartSession(sessionId: string) {
    return this.send('restart_session', { sessionId })
  }

  sendInput(sessionId: string, input: string) {
    return this.send('send_input', { sessionId, input })
  }

  sendTerminalInput(sessionId: string, data: string) {
    return this.send('terminal_input', { sessionId, data })
  }

  resizeSession(sessionId: string, cols: number, rows: number) {
    return this.send('resize_session', { sessionId, cols, rows })
  }

  updateSettings(payload: SettingsUpdate) {
    return this.send('update_settings', payload as Record<string, unknown>)
  }

  updateCommandPreset(payload: ModePreset) {
    return this.send('update_command_preset', payload as unknown as Record<string, unknown>)
  }

  diagnoseRuntime(projectId?: string) {
    return this.send('diagnose_runtime', { projectId })
  }

  diagnoseNativeRuntime() {
    return this.send('diagnose_native_runtime')
  }

  exportDiagnostics() {
    return this.send('export_diagnostics')
  }

  repairDatabase() {
    return this.send('repair_database')
  }

  resetDatabaseWithBackup() {
    return this.send('reset_database_with_backup')
  }

  diagnoseClaudestart(projectId?: string, mode?: string) {
    return this.send('diagnose_claudestart', { projectId, mode })
  }

  testShellCommand(command: string, projectId?: string) {
    return this.send('test_shell_command', { command, projectId })
  }

  testPtyStart(projectId?: string, mode?: string) {
    return this.send('test_pty_start', { projectId, mode })
  }

  hooksStatus() {
    return this.send('hooks_status')
  }

  installProjectHooks(projectId: string) {
    return this.send('install_project_hooks', { projectId })
  }

  hooksInstallPreview(projectId: string) {
    return this.send('hooks_install_preview', { projectId })
  }
}

export const runtimeClient = new RuntimeClient()
