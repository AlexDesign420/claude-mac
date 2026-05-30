import { open } from '@tauri-apps/plugin-dialog'
import {
  Activity,
  Bot,
  Braces,
  FolderKanban,
  Gauge,
  Logs,
  MessageSquareText,
  PlayCircle,
  Settings,
  Sparkles,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { PtyTerminal } from '@/components/chat/pty-terminal'
import { ErrorPanel, LogBlock, PathText, SafeText } from '@/components/safe-content'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useRuntime } from '@/hooks/use-runtime'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import type { AgentRecord, ModePreset, NavItem, RawLogRecord, SessionRecord, SubagentRecord, ToolCallRecord } from '@/types/domain'

const navItems: Array<{ id: NavItem; label: string; icon: typeof Activity }> = [
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'usage', label: 'Usage', icon: Gauge },
  { id: 'logs', label: 'Logs', icon: Logs },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function App() {
  useRuntime()

  const store = useAppStore()
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [prompt, setPrompt] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

  const selectedProject =
    store.projects.find((project) => project.id === store.selectedProjectId) ?? store.projects[0] ?? null
  const selectedSession =
    store.sessions.find((session) => session.id === store.selectedSessionId && ['running', 'active'].includes(session.status)) ??
    store.sessions.find((session) => session.projectId === selectedProject?.id && ['running', 'active'].includes(session.status)) ??
    store.sessions.find((session) => session.id === store.selectedSessionId) ??
    store.sessions.find((session) => session.projectId === selectedProject?.id) ??
    store.sessions[0] ??
    null
  const liveSelectedSession = selectedSession && ['running', 'active'].includes(selectedSession.status) ? selectedSession : null

  const activeAgents = store.agents.filter((agent) => agent.status === 'running')
  const activeSessions = store.sessions.filter((session) => session.status === 'active' || session.status === 'running')
  const runtimeOnline = store.connection.status === 'connected' && Boolean(store.runtime.port)
  const primaryStartLabel = runtimeOnline ? 'Claude Code starten' : 'Runtime reparieren'
  const pickStartLabel = runtimeOnline ? 'Projektordner auswählen und Claude Code starten' : 'Runtime reparieren'
  const selectedAgent =
    store.agents.find((agent) => agent.id === selectedAgentId) ?? store.agents[0] ?? null
  const selectedProjectToolCalls = selectedProject
    ? store.toolCalls.filter((toolCall) => toolCall.projectId === selectedProject.id)
    : store.toolCalls
  const selectedProjectSubagents = selectedProject
    ? store.subagents.filter((subagent) => subagent.projectId === selectedProject.id)
    : store.subagents
  const toolStats = selectedProjectToolCalls.reduce<Record<string, number>>((acc, toolCall) => {
    acc[toolCall.toolName] = (acc[toolCall.toolName] ?? 0) + 1
    return acc
  }, {})

  const chartData = store.usageSnapshots
    .slice(-18)
    .reverse()
    .map((snapshot) => ({
      timestamp: new Date(snapshot.capturedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
      tokens: snapshot.totalTokens,
      perMinute: snapshot.tokensPerMinute,
    }))
    .reverse()

  const sessionLogs = useMemo(
    () =>
      selectedSession
        ? store.rawLogs.filter((log) => log.sessionId === selectedSession.id)
        : [],
    [selectedSession, store.rawLogs],
  )

  const groupedMessages = useMemo(() => groupLogsIntoMessages(sessionLogs), [sessionLogs])

  const agentLogs = useMemo(() => {
    if (!selectedAgent) {
      return []
    }
    return store.rawLogs.filter((log) => log.id === selectedAgent.sourceLogId || log.sessionId === selectedAgent.sessionId).slice(-40)
  }, [selectedAgent, store.rawLogs])

  const handleProjectPick = async () => {
    const selection = await open({
      directory: true,
      multiple: false,
      title: 'Projektordner auswählen',
    })

    if (typeof selection === 'string') {
      setProjectPath(selection)
      if (!projectName) {
        setProjectName(selection.split('/').filter(Boolean).at(-1) ?? 'New Project')
      }
    }
  }

  const handleCreateProject = async () => {
    if (!projectPath.trim()) {
      return
    }

    await store.createProject({
      name: projectName.trim() || projectPath.split('/').filter(Boolean).at(-1) || 'Project',
      path: projectPath.trim(),
    })
    setProjectName('')
    setProjectPath('')
  }

  const handlePickProjectAndStart = async () => {
    const selection = await open({
      directory: true,
      multiple: false,
      title: 'Projektordner auswählen und Claude Code starten',
    })

    if (typeof selection !== 'string') {
      return
    }

    await store.createProjectAndStart({
      name: selection.split('/').filter(Boolean).at(-1) ?? 'Project',
      path: selection,
    })
    store.setNav('chat')
  }

  const handleStartClaude = async () => {
    if (!runtimeOnline) {
      await store.restartSidecar()
      return
    }

    if (!selectedProject) {
      await handlePickProjectAndStart()
      return
    }

    await store.startSession(selectedProject.id)
    store.setNav('chat')
  }

  const handleInstallHooks = async () => {
    if (!runtimeOnline) {
      await store.restartSidecar()
      return
    }

    if (!selectedProject) {
      await handlePickProjectAndStart()
      return
    }

    await store.installProjectHooks(selectedProject.id)
  }

  const handleStartDiagnostics = async () => {
    if (!runtimeOnline) {
      store.openDiagnostics()
      await store.restartSidecar()
      return
    }
    await store.diagnoseClaudestart()
  }

  const handleSend = async (value: string) => {
    if (!liveSelectedSession || !value.trim()) {
      return
    }

    await store.sendInput(liveSelectedSession.id, value)
    setPrompt('')
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(242,181,107,0.16),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(217,119,69,0.13),_transparent_26%),linear-gradient(160deg,_var(--app-bg)_0%,_var(--app-bg-soft)_48%,_var(--app-bg-strong)_100%)] text-[var(--app-text)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,248,238,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,248,238,0.035)_1px,transparent_1px)] bg-[size:56px_56px] opacity-60" />
      <div className="relative grid min-h-screen grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] 2xl:grid-cols-[260px_minmax(0,1fr)_340px]">
        <aside className="hidden min-w-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-surface)] p-5 backdrop-blur-2xl lg:flex">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-200 shadow-lg shadow-cyan-950/30">
              <SquareTerminal className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm uppercase tracking-[0.26em] text-slate-400">Claude Engine</p>
              <h1 className="text-lg font-semibold">Claude Mac App</h1>
            </div>
          </div>

          <nav className="space-y-2">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={cn(
                  'flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition',
                  store.nav === id
                    ? 'bg-white/10 text-white shadow-lg shadow-slate-900/40'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-100',
                )}
                onClick={() => store.setNav(id)}
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-4 w-4" />
                  {label}
                </span>
                {id === 'agents' && activeAgents.length > 0 ? <Badge variant="info">{activeAgents.length}</Badge> : null}
              </button>
            ))}
          </nav>

          <div className="mt-auto space-y-3">
            <Card>
              <p className="text-xs uppercase tracking-[0.22em] text-[var(--app-muted)]">Runtime</p>
              <div className="mt-3 flex items-center gap-2">
                <span
                  className={cn(
                    'h-2.5 w-2.5 rounded-full',
                    store.connection.status === 'connected'
                      ? 'bg-[var(--app-success)]'
                      : store.connection.status === 'error'
                        ? 'bg-[var(--app-error)]'
                        : 'bg-[var(--app-warning)]',
                  )}
                />
                <p className="text-sm text-[var(--app-text)]">{store.connection.status}</p>
              </div>
              <p className="mt-2 break-words text-xs text-[var(--app-muted)]">
                Sidecar {store.runtime.port ? `:${store.runtime.port}` : 'wird initialisiert'} · {store.runtime.launchMode}
              </p>
            </Card>

            <Card className="bg-[linear-gradient(145deg,rgba(217,119,69,0.16),rgba(255,248,238,0.05))]">
              <div className="flex items-center gap-2 text-[var(--app-accent-2)]">
                <Sparkles className="h-4 w-4" />
                <p className="text-sm font-medium">Autonomie-Profil</p>
              </div>
              <p className="mt-2 text-sm text-[var(--app-text-secondary)]">
                {store.commandPresets.find((preset) => preset.mode === store.settings.defaultMode)?.label ?? store.settings.defaultMode}
              </p>
              <p className="mt-1 text-xs text-[var(--app-muted)]">Presets kommen jetzt direkt aus SQLite und bleiben editierbar.</p>
            </Card>
          </div>
        </aside>

        <main className="flex min-h-screen min-w-0 flex-col">
          <header className="border-b border-[var(--app-border)] bg-[var(--app-surface)] px-4 py-5 backdrop-blur-xl md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.24em] text-[var(--app-muted)]">Project Session Shell</p>
                <h2 className="text-2xl font-semibold tracking-tight">{selectedProject?.name ?? 'Noch kein Projekt gewählt'}</h2>
                <PathText className="mt-1" value={selectedProject?.path ?? 'Kein Projektpfad'} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={handleStartClaude}>{primaryStartLabel}</Button>
                <Button variant="secondary" onClick={handleInstallHooks}>{runtimeOnline ? 'Hooks installieren' : 'Runtime reparieren'}</Button>
                {!runtimeOnline ? <Button variant="secondary" onClick={() => void store.openDiagnostics()}>Diagnose öffnen</Button> : null}
                <Badge variant={activeSessions.length ? 'success' : 'muted'}>{activeSessions.length} aktive Sessions</Badge>
                <Badge variant={activeAgents.length ? 'info' : 'muted'}>{activeAgents.length} aktive Agents</Badge>
              </div>
            </div>
            <nav className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
              {navItems.map(({ id, label }) => (
                <Button
                  key={id}
                  size="sm"
                  variant={store.nav === id ? 'default' : 'secondary'}
                  onClick={() => store.setNav(id)}
                >
                  {label}
                </Button>
              ))}
            </nav>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
            <Card className="mb-6 border-[var(--app-accent)]/25 bg-[var(--app-accent)]/10">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-[var(--app-muted)]">Start Flow</p>
                  <p className="mt-1 text-sm text-[var(--app-text-secondary)]">{store.startStatus}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={handleStartClaude}>{primaryStartLabel}</Button>
                  <Button variant="secondary" onClick={runtimeOnline ? handlePickProjectAndStart : () => void store.restartSidecar()}>{pickStartLabel}</Button>
                  <Button variant="secondary" onClick={handleInstallHooks}>{runtimeOnline ? 'Hooks installieren' : 'Sidecar neu starten'}</Button>
                  <Button variant="secondary" onClick={() => void handleStartDiagnostics()}>Diagnose</Button>
                </div>
              </div>
            </Card>

            {store.connection.lastError ? (
              <ErrorPanel
                className="mb-6"
                title={store.connection.lastError.message}
                actions={(
                  <>
                    <Button variant="secondary" onClick={store.openDiagnostics}>Diagnose öffnen</Button>
                    <Button variant="secondary" onClick={() => void store.restartSidecar()}>Sidecar neu starten</Button>
                    <Button variant="secondary" onClick={() => void store.repairDatabase()}>Datenbank reparieren</Button>
                    <Button variant="destructive" onClick={() => void store.resetDatabaseWithBackup()}>Datenbank sichern & resetten</Button>
                  </>
                )}
              >
                {store.connection.lastError.shell ? <SafeText className="block">Shell: {store.connection.lastError.shell}</SafeText> : null}
                {store.connection.lastError.cwd ? <PathText value={store.connection.lastError.cwd} /> : null}
                {store.connection.lastError.path ? <LogBlock value={`PATH=${store.connection.lastError.path}`} /> : null}
                {store.connection.lastError.typeResult ? <SafeText className="block">type claudestart: {store.connection.lastError.typeResult}</SafeText> : null}
                {store.connection.lastError.details ? <LogBlock value={store.connection.lastError.details} /> : null}
                {store.connection.lastError.suggestion ? <SafeText className="block">{store.connection.lastError.suggestion}</SafeText> : null}
                {isDatabaseSchemaError(store.connection.lastError) ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant="info">Schema-Reparatur verfügbar</Badge>
                  </div>
                ) : null}
              </ErrorPanel>
            ) : null}

            <AnimatePresence mode="wait">
              <motion.div
                key={store.nav}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.22 }}
                className="space-y-6"
              >
                {store.nav === 'activity' ? (
                  <>
                    <Card className="border-cyan-400/20 bg-white/[0.04]">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Claude Code</p>
                          <h3 className="mt-2 text-xl font-semibold">Terminal-Workflow in der App starten</h3>
                          <p className="mt-2 text-sm text-slate-400">{selectedProject?.path ?? 'Noch kein Projekt gespeichert'}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button onClick={handleStartClaude}>{primaryStartLabel}</Button>
                            <Button variant="secondary" onClick={handleInstallHooks}>{runtimeOnline ? 'Claude Hooks installieren' : 'Runtime reparieren'}</Button>
                            <Button variant="secondary" onClick={() => void handleStartDiagnostics()}>Diagnose ausführen</Button>
                            {!selectedProject ? (
                              <Button variant="secondary" onClick={runtimeOnline ? handlePickProjectAndStart : () => void store.restartSidecar()}>{pickStartLabel}</Button>
                            ) : null}
                        </div>
                      </div>
                    </Card>

                    <HookStatusPanel status={store.hookStatus} hookEvents={store.hookEvents} notifications={store.notifications} onRefresh={store.refreshHookStatus} />

                    <DiagnosisPanel
                      latest={store.diagnostics.latest}
                      runtimeEvents={store.runtimeEvents}
                      onRuntime={store.diagnoseRuntime}
                      onNative={store.diagnoseNativeRuntime}
                      onClaude={store.diagnoseClaudestart}
                      onPty={store.testStartCommand}
                    />

                    <section className="grid gap-4 xl:grid-cols-4">
                      <MetricCard label="Projekte" value={store.projects.length} hint="Persistiert in SQLite" icon={FolderKanban} />
                      <MetricCard label="Sessions" value={activeSessions.length} hint="Live PTY-Verbindungen" icon={PlayCircle} />
                      <MetricCard label="Subagents" value={selectedProjectSubagents.length || activeAgents.length} hint="Primär aus Claude Hooks" icon={Bot} />
                      <MetricCard label="Tool Calls" value={selectedProjectToolCalls.length} hint="Timeline aus Hook-Events" icon={Wrench} />
                    </section>

                    <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                      <ToolTimeline toolCalls={selectedProjectToolCalls.slice(0, 10)} />
                      <ToolStatsPanel stats={toolStats} />
                    </section>

                    <section className="grid gap-4 xl:grid-cols-[1.45fr_1fr]">
                      <Card className="min-h-[320px]">
                        <div className="mb-4 flex items-center justify-between">
                          <div>
                            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Usage Pulse</p>
                            <h3 className="text-lg font-semibold">Tokenverbrauch über Zeit</h3>
                          </div>
                          <Badge variant="muted">LM Studio: lokal / 0 €</Badge>
                        </div>
                        <ChartArea data={chartData} />
                      </Card>

                      <Card>
                        <div className="mb-4 flex items-center justify-between">
                          <div>
                            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Recent Signals</p>
                            <h3 className="text-lg font-semibold">Letzte Aktivitäten</h3>
                          </div>
                          <Badge variant="info">{store.rawLogs.length} Log-Einträge</Badge>
                        </div>
                        <div className="space-y-3">
                          {store.rawLogs.slice(0, 6).map((log) => (
                            <LogPreview key={log.id} log={log} />
                          ))}
                        </div>
                      </Card>
                    </section>
                  </>
                ) : null}

                {store.nav === 'chat' ? (
                  <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(280px,0.9fr)]">
                    <Card className="flex min-h-[740px] min-w-0 flex-col">
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Live Session</p>
                          <h3 className="text-lg font-semibold">{selectedSession ? selectedSession.label : 'Session auswählen'}</h3>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {(['terminal', 'chat', 'logs'] as const).map((mode) => (
                            <Button key={mode} variant={store.chatSurfaceMode === mode ? 'default' : 'secondary'} onClick={() => store.setChatSurfaceMode(mode)}>
                              {mode === 'terminal' ? 'Terminal' : mode === 'chat' ? 'Chat' : 'Logs'}
                            </Button>
                          ))}
                          <Button variant="secondary" onClick={() => liveSelectedSession && handleSend('/status')}>/status</Button>
                          <Button variant="secondary" onClick={() => liveSelectedSession && handleSend('/agents')}>/agents</Button>
                          <Button variant="secondary" onClick={() => liveSelectedSession && handleSend('/clear')}>/clear</Button>
                          <Button variant="secondary" onClick={() => liveSelectedSession && handleSend('/compact')}>/compact</Button>
                          <Button variant="secondary" onClick={() => selectedSession && store.restartSession(selectedSession.id)}>Restart</Button>
                          <Button variant="destructive" onClick={() => selectedSession && store.stopSession(selectedSession.id)}>Stop</Button>
                        </div>
                      </div>

                      <div className="flex-1 overflow-hidden">
                        {store.chatSurfaceMode === 'terminal' ? (
                          liveSelectedSession ? (
                            <div className="h-full max-w-full overflow-hidden rounded-[28px] border border-[var(--app-border)] bg-black/20 p-3">
                              <PtyTerminal sessionId={liveSelectedSession.id} logs={store.rawLogs} />
                            </div>
                          ) : (
                              <EmptyState
                                text="Keine laufende Claude-Code-Session."
                                actionLabel={selectedProject ? primaryStartLabel : pickStartLabel}
                                onAction={selectedProject ? handleStartClaude : handlePickProjectAndStart}
                                disabled={false}
                              />
                          )
                        ) : null}

                        {store.chatSurfaceMode === 'chat' ? (
                              <div className="space-y-4 overflow-y-auto pr-1">
                            {groupedMessages.length ? (
                              groupedMessages.map((message) => (
                                <div
                                  key={message.id}
                                  className={cn(
                                    'min-w-0 rounded-3xl border p-4',
                                    message.role === 'user'
                                      ? 'ml-0 border-[var(--app-accent)]/25 bg-[var(--app-accent)]/10 md:ml-20'
                                      : 'mr-0 border-[var(--app-border)] bg-black/15 md:mr-10',
                                  )}
                                >
                                  <div className="mb-3 flex items-center justify-between">
                                    <Badge variant={message.role === 'user' ? 'info' : 'muted'}>{message.role}</Badge>
                                    <span className="text-xs text-slate-500">{new Date(message.timestamp).toLocaleTimeString()}</span>
                                  </div>
                                  <SafeText className="block whitespace-pre-wrap text-[15px]">{message.content}</SafeText>
                                </div>
                              ))
                            ) : (
                              <EmptyState text="Noch keine gruppierten Chat-Blöcke. Terminal- und Log-View laufen bereits live." />
                            )}
                          </div>
                        ) : null}

                        {store.chatSurfaceMode === 'logs' ? (
                          <div className="space-y-2 overflow-y-auto font-mono text-[13px]">
                            {sessionLogs.slice(-140).reverse().map((log) => (
                              <div key={log.id} className="min-w-0 rounded-2xl border border-[var(--app-border)] bg-black/20 px-3 py-2 text-[var(--app-text-secondary)]">
                                <span className="mr-3 text-[var(--app-muted)]">{new Date(log.createdAt).toLocaleTimeString()}</span>
                                <span className="mr-3 text-[var(--app-accent-2)]">{log.direction}</span>
                                <span className="break-words">{log.chunk.replace(/\n/g, ' ')}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-4 rounded-3xl border border-[var(--app-border)] bg-[var(--app-surface)] p-4">
                        <Textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Zusätzlicher Command Sender. Normale Eingabe geht direkt im Terminal View." />
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="muted">{selectedSession?.mode ?? store.settings.defaultMode}</Badge>
                            <Badge variant="muted">{selectedSession?.shell ?? 'shell unbekannt'}</Badge>
                            <Badge variant="muted">{selectedSession?.command ?? 'Preset noch nicht geladen'}</Badge>
                          </div>
                          <div className="flex gap-2">
                            <Button variant="secondary" onClick={() => setPrompt('/status')}>Quick Status</Button>
                            <Button variant="secondary" onClick={handleInstallHooks}>Hooks</Button>
                            <Button onClick={() => handleSend(prompt)}>Senden</Button>
                          </div>
                        </div>
                      </div>
                    </Card>

                    <div className="space-y-4">
                      <Card>
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Session Actions</p>
                        <div className="mt-4 space-y-3">
                          {store.sessions.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={session.id === selectedSession?.id}
                              onSelect={() => {
                                store.setSelectedSessionId(session.id)
                                store.setSelectedProjectId(session.projectId)
                              }}
                              onRestart={() => store.restartSession(session.id)}
                              onStop={() => store.stopSession(session.id)}
                            />
                          ))}
                        </div>
                      </Card>

                      <Card>
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Recent Stream Events</p>
                        <div className="mt-4 space-y-3">
                          {sessionLogs.slice(-6).reverse().map((log) => (
                            <LogPreview key={log.id} log={log} />
                          ))}
                        </div>
                      </Card>

                      <ToolTimeline toolCalls={selectedSession ? store.toolCalls.filter((toolCall) => toolCall.sessionId === selectedSession.id).slice(0, 6) : selectedProjectToolCalls.slice(0, 6)} compact />
                    </div>
                  </section>
                ) : null}

                {store.nav === 'projects' ? (
                  <section className="grid gap-4 xl:grid-cols-[1.05fr_1.45fr]">
                    <Card>
                      <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Neues Projekt</p>
                      <h3 className="mt-2 text-lg font-semibold">Projektverwaltung</h3>
                      <div className="mt-4 space-y-3">
                        <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Anzeigename" />
                        <div className="flex gap-2">
                          <Input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/Users/you/Projects/my-app" />
                          <Button variant="secondary" onClick={handleProjectPick}>Ordner</Button>
                        </div>
                        <Button className="w-full" onClick={handleCreateProject}>Projekt speichern</Button>
                      </div>
                    </Card>

                    <Card>
                      <div className="mb-4 flex items-center justify-between">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Gespeicherte Projekte</p>
                          <h3 className="text-lg font-semibold">Persistente Workspaces</h3>
                        </div>
                        <Badge variant="muted">{store.projects.length} Projekte</Badge>
                      </div>
                      <div className="space-y-3">
                        {store.projects.map((project) => {
                          const projectSessions = store.sessions.filter((session) => session.projectId === project.id)
                          return (
                            <div key={project.id} className={cn('rounded-3xl border p-4 transition', selectedProject?.id === project.id ? 'border-cyan-400/30 bg-cyan-400/8' : 'border-white/10 bg-white/[0.02]')}>
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <h4 className="text-base font-semibold">{project.name}</h4>
                                  <p className="mt-1 text-sm text-slate-400">{project.path}</p>
                                </div>
                          <Badge variant={project.status === 'active' ? 'success' : 'muted'}>{project.status}</Badge>
                              </div>
                              <div className="mt-4 flex flex-wrap items-center gap-2">
                              <Button variant="secondary" onClick={() => { store.setSelectedProjectId(project.id); store.setNav('chat') }}>Öffnen</Button>
                              <Button onClick={() => runtimeOnline ? store.startSession(project.id) : store.restartSidecar()}>{runtimeOnline ? 'Claude Code starten' : 'Runtime reparieren'}</Button>
                              <Button variant="secondary" onClick={() => { store.setSelectedProjectId(project.id); void (runtimeOnline ? store.installProjectHooks(project.id) : store.restartSidecar()) }}>{runtimeOnline ? 'Hooks installieren' : 'Sidecar neu starten'}</Button>
                              <Button variant="secondary" onClick={() => { store.setSelectedProjectId(project.id); void (runtimeOnline ? store.diagnoseClaudestart(project.id) : store.openDiagnostics()) }}>Diagnose</Button>
                              <Badge variant="muted">{projectSessions.length} Sessions</Badge>
                            </div>
                            </div>
                          )
                        })}
                      </div>
                    </Card>
                  </section>
                ) : null}

                {store.nav === 'agents' ? (
                  <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                    <div className="space-y-4">
                      <ExecutionTree subagents={selectedProjectSubagents} rootLabel={selectedProject?.name ?? 'Claude Session'} />
                      <div className="grid gap-4 md:grid-cols-2">
                      {store.agents.length === 0 ? (
                        <Card className="md:col-span-2">
                          <p className="text-sm text-slate-400">Sobald Claude Code Hooks Task/Subagent-Events sehen, erscheinen hier Agent Cards mit Status und Tool-Aktivität. Terminal-Regex bleibt nur Fallback.</p>
                        </Card>
                      ) : (
                        store.agents.map((agent) => (
                          <motion.button
                            key={agent.id}
                            initial={{ opacity: 0, scale: 0.96 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.2 }}
                            className="text-left"
                            onClick={() => setSelectedAgentId(agent.id)}
                          >
                            <Card className={cn('h-full', selectedAgent?.id === agent.id ? 'border-cyan-400/30' : '')}>
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Agent Card</p>
                                  <h3 className="mt-2 text-lg font-semibold">{agent.name}</h3>
                                </div>
                                <Badge variant={agent.status === 'running' ? 'success' : 'muted'}>{agent.status}</Badge>
                              </div>
                              <p className="mt-4 text-sm text-slate-300">{agent.currentTask}</p>
                              <p className="mt-3 text-xs text-slate-500">{new Date(agent.lastActivityAt).toLocaleString()}</p>
                            </Card>
                          </motion.button>
                        ))
                      )}
                      </div>
                    </div>
                    <div className="space-y-4">
                    <Card>
                      <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Agent Detail</p>
                      {selectedAgent ? (
                        <>
                          <h3 className="mt-2 text-lg font-semibold">{selectedAgent.name}</h3>
                          <div className="mt-4 space-y-3 text-sm">
                              <DetailRow label="Status" value={selectedAgent.status} />
                              <DetailRow label="Aktuelles Tool" value={selectedAgent.currentTool || 'idle'} />
                              <DetailRow label="Agent Type" value={selectedAgent.agentType || 'unknown'} />
                              <DetailRow label="Session" value={selectedAgent.sessionId} />
                              <DetailRow label="Projekt" value={selectedAgent.projectId} />
                              <DetailRow label="Tokens" value={String(selectedAgent.tokenEstimate || 0)} />
                              <DetailRow label="Transcript" value={selectedAgent.transcriptPath || 'nicht gemeldet'} />
                              <DetailRow label="Start" value={new Date(selectedAgent.startedAt).toLocaleString()} />
                              <DetailRow label="Letzte Aktivität" value={new Date(selectedAgent.lastActivityAt).toLocaleString()} />
                          </div>
                          <div className="mt-5 rounded-2xl border border-white/8 bg-white/[0.03] p-3 text-sm text-slate-300">{selectedAgent.currentTask}</div>
                          <div className="mt-5 space-y-2 font-mono text-xs">
                            {agentLogs.map((log) => (
                              <div key={log.id} className="rounded-2xl border border-white/8 bg-slate-950/65 px-3 py-2 text-slate-300">
                                <span className="mr-3 text-slate-500">{new Date(log.createdAt).toLocaleTimeString()}</span>
                                <span>{log.chunk.replace(/\n/g, ' ')}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p className="mt-4 text-sm text-slate-400">Agent wählen, um Live-Logs und Statusdetails zu sehen.</p>
                      )}
                    </Card>
                    <ToolTimeline toolCalls={selectedAgent ? store.toolCalls.filter((toolCall) => toolCall.agentId === selectedAgent.id || toolCall.sessionId === selectedAgent.sessionId).slice(0, 12) : selectedProjectToolCalls.slice(0, 12)} />
                    </div>
                  </section>
                ) : null}

                {store.nav === 'tools' ? (
                  <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
                    <ToolTimeline toolCalls={selectedProjectToolCalls.slice(0, 80)} />
                    <div className="space-y-4">
                      <ToolStatsPanel stats={toolStats} />
                      <Card>
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Tool Sessions</p>
                        <div className="mt-4 space-y-3">
                          {store.sessions.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={session.id === selectedSession?.id}
                              onSelect={() => {
                                store.setSelectedSessionId(session.id)
                                store.setSelectedProjectId(session.projectId)
                                store.setNav('chat')
                              }}
                              onRestart={() => store.restartSession(session.id)}
                              onStop={() => store.stopSession(session.id)}
                            />
                          ))}
                        </div>
                      </Card>
                    </div>
                  </section>
                ) : null}

                {store.nav === 'usage' ? (
                  <section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
                    <Card className="min-h-[360px]">
                      <div className="mb-4 flex items-center justify-between">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Consumption</p>
                          <h3 className="text-lg font-semibold">Tokens pro Snapshot</h3>
                        </div>
                        <Badge variant="muted">/status Parsing mit exact oder estimated</Badge>
                      </div>
                      <div className="h-[280px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={chartData}>
                            <CartesianGrid stroke="rgba(148,163,184,0.15)" vertical={false} />
                            <XAxis dataKey="timestamp" tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 12 }} />
                            <YAxis tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 12 }} />
                            <RechartsTooltip contentStyle={{ background: 'rgba(2,6,23,0.96)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px' }} />
                            <Bar dataKey="tokens" radius={[10, 10, 0, 0]} fill="#38bdf8" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>

                    <Card>
                      <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Live Context</p>
                      <div className="mt-4 space-y-3">
                        {store.usageSnapshots.slice(0, 8).map((snapshot) => (
                          <div key={snapshot.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-sm text-slate-200">{snapshot.model || snapshot.sessionId}</span>
                              <Badge variant={snapshot.estimated ? 'muted' : 'success'}>{snapshot.estimated ? 'geschätzt' : 'exakt'}</Badge>
                            </div>
                            <p className="mt-2 text-sm text-slate-400">
                              {snapshot.totalTokens} Tokens · {Math.round(snapshot.tokensPerMinute)} Tokens/min
                            </p>
                            <p className="mt-1 text-xs text-slate-500">{snapshot.provider || 'lokal / LM Studio'}</p>
                          </div>
                        ))}
                      </div>
                    </Card>
                  </section>
                ) : null}

                {store.nav === 'logs' ? (
                  <Card>
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Raw Stream</p>
                        <h3 className="text-lg font-semibold">Rohlogs und strukturierte Events</h3>
                      </div>
                      <Badge variant="muted">{store.rawLogs.length} gespeichert</Badge>
                    </div>
                    <div className="space-y-2 font-mono text-xs">
                      {store.rawLogs.slice(0, 160).map((log) => (
                        <div key={log.id} className="rounded-2xl border border-white/8 bg-slate-950/65 px-3 py-2 text-slate-300">
                          <span className="mr-3 text-slate-500">{new Date(log.createdAt).toLocaleTimeString()}</span>
                          <span className="mr-3 text-cyan-300">{log.direction}</span>
                          <span>{log.chunk.replace(/\n/g, ' ')}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                ) : null}

                {store.nav === 'settings' ? (
                  <section className="space-y-4">
                    <div className="grid gap-4 xl:grid-cols-[1.05fr_1.3fr]">
                      <Card>
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Runtime Settings</p>
                        <div className="mt-4 space-y-4">
                          <div>
                            <p className="mb-2 text-sm text-slate-300">Default-Modus</p>
                            <div className="flex flex-wrap gap-2">
                              {store.commandPresets.map((preset) => (
                                <Button key={preset.mode} variant={store.settings.defaultMode === preset.mode ? 'default' : 'secondary'} onClick={() => store.updateSettings({ defaultMode: preset.mode })}>
                                  {preset.label}
                                </Button>
                              ))}
                            </div>
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <ToggleSetting label="Session Recovery" enabled={store.settings.sessionRecovery} onToggle={(enabled) => store.updateSettings({ sessionRecovery: enabled })} />
                            <ToggleSetting label="Mehrere Sessions pro Projekt" enabled={store.settings.allowMultipleSessionsPerProject} onToggle={(enabled) => store.updateSettings({ allowMultipleSessionsPerProject: enabled })} />
                            <ToggleSetting label="Auto Status Poll" enabled={store.settings.autoStatusPollEnabled} onToggle={(enabled) => store.updateSettings({ autoStatusPollEnabled: enabled })} />
                            <ToggleSetting label="Logging" enabled={store.settings.loggingEnabled} onToggle={(enabled) => store.updateSettings({ loggingEnabled: enabled })} />
                          </div>
                          <SettingField label="Status Poll Minuten" value={String(store.settings.autoStatusPollMinutes)} onChange={(value) => store.updateSettings({ autoStatusPollMinutes: Number(value) || 5 })} />
                        </div>
                      </Card>

                      <Card>
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">App Health</p>
                        <div className="mt-4 space-y-4">
                          <StatusLine label="Tauri Runtime" value={store.runtime.running ? 'bereit' : 'offline'} />
                          <StatusLine label="Node Runtime" value={store.runtime.launchMode} />
                          <StatusLine label="Node Sidecar" value={store.runtime.port ? `ws://127.0.0.1:${store.runtime.port}` : 'initialisiert...'} />
                          <StatusLine label="App Data" value={store.runtime.dataDir || 'wird ermittelt'} />
                          <div className="rounded-3xl border border-amber-300/15 bg-amber-300/8 p-4 text-sm text-amber-100">
                            Release-Builds nutzen eine gebündelte Node-Runtime im App-Bundle. Dein bestehender LM-Studio- und `claudestart`-Workflow bleibt unverändert.
                          </div>
                        </div>
                      </Card>
                    </div>

                    <DiagnosisPanel
                      latest={store.diagnostics.latest}
                      runtimeEvents={store.runtimeEvents}
                      onRuntime={store.diagnoseRuntime}
                      onNative={store.diagnoseNativeRuntime}
                      onClaude={store.diagnoseClaudestart}
                      onPty={store.testStartCommand}
                    />

                    <div className="grid gap-4 md:grid-cols-2">
                      {store.commandPresets.map((preset) => (
                        <PresetEditor
                          key={preset.id}
                          preset={preset}
                          onChange={store.updateCommandPreset}
                          onTest={(mode) => store.testStartCommand(mode)}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>

        <LiveAgentTeam
          agents={store.agents.filter((agent) => !selectedProject || agent.projectId === selectedProject.id)}
          subagents={selectedProjectSubagents}
          toolCalls={selectedProjectToolCalls}
          selectedAgentId={selectedAgent?.id ?? null}
          sidecarOnline={runtimeOnline}
          hookOnline={store.hookStatus.running}
          ptyRunning={Boolean(liveSelectedSession)}
          currentProject={selectedProject?.name ?? null}
          currentSessionId={selectedSession?.id ?? null}
          onSelect={(agentId) => {
            setSelectedAgentId(agentId)
            store.setNav('agents')
          }}
        />
      </div>
    </div>
  )
}

function groupLogsIntoMessages(logs: RawLogRecord[]) {
  const ordered = logs
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  const messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: string }> = []
  let current: { id: string; role: 'user' | 'assistant'; content: string; timestamp: string } | null = null

  for (const log of ordered) {
    const role = log.direction === 'input' ? 'user' : 'assistant'
    if (!current || current.role !== role) {
      current = {
        id: log.id,
        role,
        content: log.chunk,
        timestamp: log.createdAt,
      }
      messages.push(current)
      continue
    }

    current.content += `\n${log.chunk}`
  }

  return messages.slice(-40)
}

function LiveAgentTeam({
  agents,
  subagents,
  toolCalls,
  selectedAgentId,
  sidecarOnline,
  hookOnline,
  ptyRunning,
  currentProject,
  currentSessionId,
  onSelect,
}: {
  agents: AgentRecord[]
  subagents: SubagentRecord[]
  toolCalls: ToolCallRecord[]
  selectedAgentId: string | null
  sidecarOnline: boolean
  hookOnline: boolean
  ptyRunning: boolean
  currentProject: string | null
  currentSessionId: string | null
  onSelect: (agentId: string) => void
}) {
  const team = useMemo<AgentRecord[]>(() => {
    if (agents.length) {
      return agents
    }
    return subagents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      sessionId: agent.sessionId,
      projectId: agent.projectId,
      status: agent.status,
      startedAt: agent.startedAt,
      lastActivityAt: agent.lastActivityAt,
      currentTask: agent.taskPrompt || 'Task Subagent',
      currentTool: null,
      agentType: agent.agentType,
      transcriptPath: agent.agentTranscriptPath || agent.transcriptPath,
      lastAssistantMessage: agent.lastAssistantMessage,
      tokenEstimate: agent.tokenEstimate,
      sourceLogId: agent.rawEventId,
    }))
  }, [agents, subagents])

  return (
    <aside className="hidden max-h-screen min-w-0 overflow-y-auto border-l border-[var(--app-border)] bg-[var(--app-surface)] p-5 backdrop-blur-2xl 2xl:block">
      <div className="sticky top-5 space-y-4">
        <Card className="border-[var(--app-accent)]/20 bg-[var(--app-accent)]/10">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-[var(--app-muted)]">Agent Command Center</p>
              <h3 className="mt-2 text-lg font-semibold">Live Agent Team</h3>
            </div>
            <Bot className="h-5 w-5 text-[var(--app-accent-2)]" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <StatusPill label="Sidecar" active={sidecarOnline} />
            <StatusPill label="PTY" active={ptyRunning} />
            <StatusPill label="Hooks" active={hookOnline} />
            <StatusPill label="Agents" active={team.some((agent) => agent.status === 'running')} />
          </div>
          <div className="mt-4 space-y-2 text-xs text-[var(--app-text-secondary)]">
            <p className="break-words">Projekt: {currentProject ?? 'nicht gewählt'}</p>
            <p className="truncate" title={currentSessionId ?? undefined}>Session: {currentSessionId ?? 'nicht gestartet'}</p>
          </div>
        </Card>

        <AnimatePresence initial={false}>
          {team.length ? (
            team.map((agent) => {
              const latestTool = toolCalls.find((toolCall) => toolCall.agentId === agent.id || toolCall.sessionId === agent.sessionId)
              const isSelected = selectedAgentId === agent.id
              return (
                <motion.button
                  key={agent.id}
                  layout
                  initial={{ opacity: 0, x: 24, scale: 0.96 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 24, scale: 0.96 }}
                  transition={{ duration: 0.22 }}
                  className="w-full text-left"
                  onClick={() => onSelect(agent.id)}
                >
                  <Card className={cn('relative overflow-hidden transition', isSelected ? 'border-[var(--app-accent)]/35 bg-[var(--app-accent)]/10' : 'hover:border-[var(--app-accent)]/25')}>
                    {agent.status === 'running' ? (
                      <div className="absolute right-3 top-3 rounded-full border border-[var(--app-accent-2)]/30 bg-[var(--app-accent-2)]/12 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--app-text)]">
                        New Agent spawned
                      </div>
                    ) : null}
                    <div className="flex items-start gap-3">
                      <div className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border', agentStatusClass(agent.status))}>
                        <Bot className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="truncate text-sm font-semibold text-[var(--app-text)]">{agent.name}</h4>
                          <Badge variant={agent.status === 'running' ? 'success' : agent.status === 'waiting' ? 'info' : 'muted'}>{agent.status}</Badge>
                        </div>
                        <p className="mt-2 line-clamp-3 break-words text-xs text-[var(--app-text-secondary)]">{agent.currentTask || 'Noch keine Aufgabe erkannt'}</p>
                      </div>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                      <MiniFact label="Tool" value={agent.currentTool || latestTool?.toolName || 'idle'} />
                      <MiniFact label="Laufzeit" value={formatRuntime(agent.startedAt)} />
                      <MiniFact label="Tokens" value={String(agent.tokenEstimate || 0)} />
                      <MiniFact label="Aktiv" value={new Date(agent.lastActivityAt).toLocaleTimeString()} />
                    </div>
                  </Card>
                </motion.button>
              )
            })
          ) : (
            <Card className="border-dashed text-sm text-[var(--app-text-secondary)]">
              Noch kein Agent im Team. Installiere Hooks und starte `claudestart`, dann werden Task-Subagents hier live als Worker sichtbar.
            </Card>
          )}
        </AnimatePresence>
      </div>
    </aside>
  )
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return (
    <div className={cn('rounded-2xl border px-3 py-2', active ? 'border-[var(--app-success)]/25 bg-[var(--app-success)]/12 text-[var(--app-text)]' : 'border-[var(--app-border)] bg-[var(--app-surface)] text-[var(--app-muted)]')}>
      {label}: {active ? 'online' : 'offline'}
    </div>
  )
}

function MiniFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--app-border)] bg-black/15 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--app-muted)]">{label}</p>
      <p className="mt-1 truncate text-[var(--app-text)]" title={value}>{value}</p>
    </div>
  )
}

function agentStatusClass(status: string) {
  if (status === 'running') {
    return 'border-[var(--app-success)]/30 bg-[var(--app-success)]/14 text-[var(--app-text)]'
  }
  if (status === 'waiting') {
    return 'border-[var(--app-warning)]/30 bg-[var(--app-warning)]/14 text-[var(--app-text)]'
  }
  if (status === 'failed') {
    return 'border-[var(--app-error)]/30 bg-[var(--app-error)]/14 text-[var(--app-text)]'
  }
  if (status === 'completed') {
    return 'border-[var(--app-border)] bg-[var(--app-surface)] text-[var(--app-text-secondary)]'
  }
  return 'border-[var(--app-accent-2)]/25 bg-[var(--app-accent-2)]/12 text-[var(--app-text)]'
}

function formatRuntime(startedAt: string) {
  const elapsedMs = Math.max(0, Date.now() - new Date(startedAt).getTime())
  const minutes = Math.floor(elapsedMs / 60_000)
  const seconds = Math.floor((elapsedMs % 60_000) / 1000)
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function isDatabaseSchemaError(error: ReturnType<typeof useAppStore.getState>['connection']['lastError']) {
  if (!error) {
    return false
  }
  const haystack = [error.message, error.details, error.stderr, error.stdout, error.suggestion]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return haystack.includes('no such column') || haystack.includes('command_presets') || haystack.includes('migration')
}

function MetricCard({ label, value, hint, icon: Icon }: { label: string; value: number; hint: string; icon: typeof Activity }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight">{value}</p>
          <p className="mt-2 text-sm text-slate-400">{hint}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-cyan-200">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  )
}

function ChartArea({ data }: { data: Array<{ timestamp: string; tokens: number; perMinute: number }> }) {
  return (
    <div className="h-[250px] min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="usageFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.7} />
              <stop offset="95%" stopColor="#22d3ee" stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(148,163,184,0.15)" vertical={false} />
          <XAxis dataKey="timestamp" tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 12 }} />
          <YAxis tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 12 }} />
          <RechartsTooltip contentStyle={{ background: 'rgba(2,6,23,0.96)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px' }} />
          <Area type="monotone" dataKey="tokens" stroke="#22d3ee" strokeWidth={2} fill="url(#usageFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function HookStatusPanel({
  status,
  hookEvents,
  notifications,
  onRefresh,
}: {
  status: ReturnType<typeof useAppStore.getState>['hookStatus']
  hookEvents: ReturnType<typeof useAppStore.getState>['hookEvents']
  notifications: ReturnType<typeof useAppStore.getState>['notifications']
  onRefresh: () => Promise<void>
}) {
  return (
    <Card className="border-emerald-300/15 bg-emerald-300/8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Claude Hook Layer</p>
          <h3 className="mt-2 text-lg font-semibold">Observability Receiver</h3>
          <p className="mt-2 text-sm text-slate-400">{status.url || 'Hook Receiver startet...'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status.running ? 'success' : 'muted'}>{status.running ? 'receiver online' : 'offline'}</Badge>
          <Badge variant="info">{status.eventsReceived} Hook Events</Badge>
          <Button variant="secondary" onClick={() => void onRefresh()}>Hook Status prüfen</Button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {hookEvents.slice(0, 3).map((event) => (
          <div key={event.id} className="rounded-2xl border border-white/8 bg-slate-950/45 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-cyan-100">{event.hookEventName}</span>
              <span className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleTimeString()}</span>
            </div>
            <p className="mt-2 text-xs text-slate-400">{event.toolName || event.agentId || 'Session Event'}</p>
          </div>
        ))}
        {hookEvents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-3 text-sm text-slate-400">
            Noch keine Hooks gesehen. Installiere Hooks im Projekt und starte Claude Code.
          </div>
        ) : null}
      </div>
      {notifications.length ? (
        <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/8 p-3 text-sm text-amber-100">
          Letzte Notification: {notifications[0].message}
        </div>
      ) : null}
    </Card>
  )
}

function ToolTimeline({ toolCalls, compact = false }: { toolCalls: ToolCallRecord[]; compact?: boolean }) {
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Tool Timeline</p>
          <h3 className="text-lg font-semibold">Claude Tool Calls</h3>
        </div>
        <Badge variant="info">{toolCalls.length}</Badge>
      </div>
      <div className="space-y-2">
        {toolCalls.length ? (
          toolCalls.map((toolCall) => (
            <div key={toolCall.id} className="rounded-2xl border border-white/8 bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-cyan-200" />
                  <span className="text-sm font-medium text-slate-100">{toolCall.toolName}</span>
                  <Badge variant={toolCall.status === 'failed' ? 'muted' : toolCall.status === 'running' ? 'info' : 'success'}>{toolCall.status}</Badge>
                </div>
                <span className="text-xs text-slate-500">
                  {toolCall.durationMs ? `${Math.round(toolCall.durationMs)} ms` : new Date(toolCall.startedAt).toLocaleTimeString()}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-400">{toolCall.inputSummary || toolCall.filePath || 'ohne Input Summary'}</p>
              {!compact && toolCall.outputSummary ? (
                <p className="mt-2 line-clamp-2 text-xs text-slate-500">{toolCall.outputSummary}</p>
              ) : null}
            </div>
          ))
        ) : (
          <p className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-sm text-slate-400">
            Noch keine echten Tool-Call-Hooks empfangen.
          </p>
        )}
      </div>
    </Card>
  )
}

function ToolStatsPanel({ stats }: { stats: Record<string, number> }) {
  const entries = Object.entries(stats).sort(([, a], [, b]) => b - a).slice(0, 8)
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Tool Dashboard</p>
          <h3 className="text-lg font-semibold">Aktivität nach Tool</h3>
        </div>
        <Braces className="h-5 w-5 text-cyan-200" />
      </div>
      <div className="space-y-3">
        {entries.length ? entries.map(([toolName, count]) => (
          <div key={toolName} className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2">
            <span className="text-sm text-slate-200">{toolName}</span>
            <Badge variant="info">{count}</Badge>
          </div>
        )) : (
          <p className="text-sm text-slate-400">Bash, Read, Edit, Write, Grep, Glob, Task und Web-Tools erscheinen hier, sobald Hooks feuern.</p>
        )}
      </div>
    </Card>
  )
}

function ExecutionTree({ subagents, rootLabel }: { subagents: SubagentRecord[]; rootLabel: string }) {
  const rootAgents = subagents.filter((agent) => !agent.parentAgentId || !subagents.some((candidate) => candidate.id === agent.parentAgentId))
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Execution Tree</p>
          <h3 className="text-lg font-semibold">{rootLabel}</h3>
        </div>
        <Badge variant={subagents.length ? 'info' : 'muted'}>{subagents.length} Nodes</Badge>
      </div>
      <div className="space-y-2">
        <TreeNode label={rootLabel} status="running" depth={0} />
        {rootAgents.length ? (
          rootAgents.map((agent) => (
            <SubagentTreeNode key={agent.id} agent={agent} allAgents={subagents} depth={1} />
          ))
        ) : (
          <p className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-3 text-sm text-slate-400">
            Noch keine Subagent-Struktur. Task-Hooks erzeugen hier rekursive Nodes.
          </p>
        )}
      </div>
    </Card>
  )
}

function SubagentTreeNode({ agent, allAgents, depth }: { agent: SubagentRecord; allAgents: SubagentRecord[]; depth: number }) {
  const children = allAgents.filter((candidate) => candidate.parentAgentId === agent.id)
  return (
    <>
      <TreeNode label={agent.name} status={agent.status} detail={agent.taskPrompt || undefined} depth={depth} />
      {children.map((child) => (
        <SubagentTreeNode key={child.id} agent={child} allAgents={allAgents} depth={depth + 1} />
      ))}
    </>
  )
}

function TreeNode({ label, status, detail, depth }: { label: string; status: string; detail?: string; depth: number }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-slate-950/45 p-3" style={{ marginLeft: depth * 18 }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-slate-100">{label}</span>
        <Badge variant={status === 'failed' ? 'muted' : status === 'completed' ? 'success' : 'info'}>{status}</Badge>
      </div>
      {detail ? <p className="mt-2 line-clamp-2 text-xs text-slate-500">{detail}</p> : null}
    </div>
  )
}

function SessionRow({
  session,
  active,
  onSelect,
  onRestart,
  onStop,
}: {
  session: SessionRecord
  active: boolean
  onSelect: () => void
  onRestart: () => void
  onStop: () => void
}) {
  return (
    <div className={cn('rounded-2xl border p-3 transition', active ? 'border-cyan-400/30 bg-cyan-400/8' : 'border-white/10 bg-white/[0.02]')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-slate-100">{session.label}</h4>
          <p className="mt-1 text-xs text-slate-500">{session.command || session.projectId}</p>
        </div>
        <Badge variant={session.status === 'active' || session.status === 'running' ? 'success' : 'muted'}>{session.status}</Badge>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="sm" onClick={onSelect}>Focus</Button>
        <Button variant="secondary" size="sm" onClick={onRestart}>Restart</Button>
        <Button variant="destructive" size="sm" onClick={onStop}>Stop</Button>
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2">
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-200">{value}</span>
    </div>
  )
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-200">{value}</span>
    </div>
  )
}

function SettingField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <p className="mb-2 text-sm text-slate-300">{label}</p>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

function ToggleSetting({ label, enabled, onToggle }: { label: string; enabled: boolean; onToggle: (value: boolean) => void }) {
  return (
    <button
      className={cn('rounded-2xl border px-4 py-3 text-left text-sm transition', enabled ? 'border-cyan-400/25 bg-cyan-400/10 text-cyan-50' : 'border-white/10 bg-white/[0.02] text-slate-300')}
      onClick={() => onToggle(!enabled)}
    >
      {label}: {enabled ? 'aktiv' : 'deaktiviert'}
    </button>
  )
}

function PresetEditor({
  preset,
  onChange,
  onTest,
}: {
  preset: ModePreset
  onChange: (preset: ModePreset) => Promise<void>
  onTest: (mode: ModePreset['mode']) => Promise<void>
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{preset.mode}</p>
          <h3 className="mt-2 text-lg font-semibold">{preset.label}</h3>
        </div>
        <Badge variant={preset.enabled ? 'success' : 'muted'}>{preset.enabled ? 'enabled' : 'disabled'}</Badge>
      </div>
      <div className="mt-4 space-y-3">
        <SettingField label="Label" value={preset.label} onChange={(value) => void onChange({ ...preset, label: value })} />
        <SettingField label="Startbefehl" value={preset.startCommand} onChange={(value) => void onChange({ ...preset, startCommand: value })} />
        <SettingField label="Startargumente" value={preset.startArgs.join(' ')} onChange={(value) => void onChange({ ...preset, startArgs: value.split(' ').map((item) => item.trim()).filter(Boolean) })} />
        <Textarea rows={3} value={JSON.stringify(preset.env, null, 2)} onChange={(event) => {
          try {
            const parsed = JSON.parse(event.target.value || '{}') as Record<string, string>
            void onChange({ ...preset, env: parsed })
          } catch {
            // wait for valid JSON
          }
        }} />
        <Textarea rows={3} value={preset.description} onChange={(event) => void onChange({ ...preset, description: event.target.value })} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void onTest(preset.mode)}>Test Startbefehl</Button>
          <Button variant={preset.enabled ? 'secondary' : 'default'} onClick={() => void onChange({ ...preset, enabled: !preset.enabled })}>
            {preset.enabled ? 'Deaktivieren' : 'Aktivieren'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function DiagnosisPanel({
  latest,
  runtimeEvents,
  onRuntime,
  onNative,
  onClaude,
  onPty,
}: {
  latest: ReturnType<typeof useAppStore.getState>['diagnostics']['latest']
  runtimeEvents: ReturnType<typeof useAppStore.getState>['runtimeEvents']
  onRuntime: () => Promise<void>
  onNative: () => Promise<void>
  onClaude: () => Promise<void>
  onPty: () => Promise<void>
}) {
  return (
    <Card className="border-cyan-400/20">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Start Diagnose</p>
          <h3 className="mt-2 text-lg font-semibold">{latest?.ok === false ? 'Startproblem erkannt' : 'Runtime pruefen'}</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void onRuntime()}>Runtime Diagnose</Button>
          <Button variant="secondary" onClick={() => void onNative()}>Native Runtime prüfen</Button>
          <Button variant="secondary" onClick={() => void onClaude()}>claudestart Diagnose</Button>
          <Button onClick={() => void onPty()}>Test Startbefehl</Button>
        </div>
      </div>

      {latest ? (
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          <DetailRow label="Shell" value={latest.shell || 'unbekannt'} />
          <DetailRow label="HOME" value={latest.home || 'unbekannt'} />
          <DetailRow label="USER" value={latest.user || 'unbekannt'} />
          <DetailRow label="cwd" value={latest.cwd || 'unbekannt'} />
          <DetailRow label="which" value={latest.which || '(leer)'} />
          <DetailRow label="command -v" value={latest.commandV || '(leer)'} />
          <DetailRow label="type" value={latest.type || latest.typeResult || '(leer)'} />
          <DetailRow label="exit code" value={String(latest.exitCode ?? 'n/a')} />
          <DetailRow label="Node" value={latest.nodeBinary || latest.nodeVersion || 'n/a'} />
          <DetailRow label="Platform" value={[latest.platform, latest.arch].filter(Boolean).join(' / ') || 'n/a'} />
          <DetailRow label="Resource" value={latest.resourceDir || latest.sidecarRoot || 'n/a'} />
          <DetailRow label="finaler Startbefehl" value={latest.finalStartCommand || '(leer)'} />
          <DetailRow label="finaler PTY-Befehl" value={latest.finalPtyCommand || '(leer)'} />
          {latest.nativeRuntimeStatus ? (
            <PreBlock label="nativeRuntimeStatus" value={JSON.stringify(latest.nativeRuntimeStatus, null, 2)} />
          ) : null}
          {latest.betterSqlite3 ? <PreBlock label="better-sqlite3" value={JSON.stringify(latest.betterSqlite3, null, 2)} /> : null}
          {latest.nodePty ? <PreBlock label="node-pty" value={JSON.stringify(latest.nodePty, null, 2)} /> : null}
          {latest.spawnHelper ? <PreBlock label="spawn-helper" value={JSON.stringify(latest.spawnHelper, null, 2)} /> : null}
          <div className="lg:col-span-2 rounded-2xl border border-white/8 bg-slate-950/70 p-3 text-xs text-slate-300">
            <p className="mb-2 text-slate-500">PATH</p>
            <p className="break-all font-mono">{latest.path || '(leer)'}</p>
          </div>
          <div className="lg:col-span-2 rounded-2xl border border-white/8 bg-slate-950/70 p-3 text-xs text-slate-300">
            <p className="mb-2 text-slate-500">Shell-Dateien</p>
            <div className="grid gap-2 md:grid-cols-2">
              {(latest.shellFiles || []).map((file) => (
                <span key={file.path} className={file.exists ? 'text-emerald-200' : 'text-slate-500'}>
                  {file.name}: {file.exists ? 'existiert' : 'fehlt'}
                </span>
              ))}
            </div>
          </div>
          <PreBlock label="stdout" value={latest.stdout} />
          <PreBlock label="stderr" value={latest.stderr} />
          {latest.suggestion ? (
            <div className="lg:col-span-2 rounded-2xl border border-amber-300/15 bg-amber-300/8 p-3 text-sm text-amber-100">
              {latest.suggestion}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 space-y-2 font-mono text-xs">
        {runtimeEvents.slice(0, 10).map((event) => (
          <div key={`${event.eventType}-${event.createdAt}`} className="rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2 text-slate-300">
            <span className="mr-3 text-cyan-300">{event.eventType}</span>
            <span className="text-slate-500">{new Date(event.createdAt).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function PreBlock({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-slate-950/70 p-3 text-xs text-slate-300">
      <p className="mb-2 text-slate-500">{label}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono">{value || '(leer)'}</pre>
    </div>
  )
}

function LogPreview({ log }: { log: RawLogRecord }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center justify-between gap-4">
        <Badge variant={log.direction === 'input' ? 'info' : log.direction === 'error' ? 'muted' : 'success'}>{log.direction}</Badge>
        <span className="text-xs text-slate-500">{new Date(log.createdAt).toLocaleTimeString()}</span>
      </div>
      <p className="line-clamp-3 text-sm text-slate-300">{log.chunk.replace(/\s+/g, ' ').trim() || 'Streaming chunk'}</p>
    </div>
  )
}

function EmptyState({
  text,
  actionLabel,
  onAction,
  disabled = false,
}: {
  text: string
  actionLabel?: string
  onAction?: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center text-sm text-slate-400">
      <p>{text}</p>
      {actionLabel && onAction ? <Button onClick={onAction} disabled={disabled}>{actionLabel}</Button> : null}
    </div>
  )
}

export default App
