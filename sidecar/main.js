import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { v4 as uuid } from 'uuid'
import { WebSocketServer } from 'ws'

import { JsonFileDatabase } from './src/json-file-db.js'
import { getTableColumns, migrateAll } from './src/db/migrations.js'
import { SchemaValidationError, validateSchema } from './src/db/schema.js'
import {
  buildStartCommand,
  buildStartDiagnostic,
  getShellPath,
  resolveStartInvocation,
  runShellDiagnostic,
  shellArgsForInteractiveLoginCommand,
  shellQuote,
} from './src/shell.js'
import { DEFAULT_MODE_PRESETS, sortModePresets } from './src/presets.js'
import { AgentParser } from './src/parsers/agent-parser.js'
import { UsageParser } from './src/parsers/usage-parser.js'

const DEFAULT_SETTINGS = {
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

const sidecarRoot = path.dirname(fileURLToPath(import.meta.url))
const appDataDir = process.env.CLAUDE_MAC_APP_DATA_DIR || path.join(process.cwd(), '.claude-mac-app')
const daemonManifestPath = path.join(appDataDir, 'sidecar-daemon.json')
fs.mkdirSync(appDataDir, { recursive: true })
const bootstrapDiagnostics = globalThis.__CLAUDE_MAC_NATIVE_DIAGNOSTICS__ || null
const bootstrapModules = globalThis.__CLAUDE_MAC_NATIVE_MODULES__ || {}
const Database = bootstrapModules.betterSqlite3?.default || bootstrapModules.betterSqlite3 || null
const pty = bootstrapModules.nodePty?.default || bootstrapModules.nodePty || null

function ensureNodePtyHelperExecutable() {
  const helperPath = path.join(
    sidecarRoot,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  )
  if (!fs.existsSync(helperPath)) {
    return {
      ok: false,
      helperPath,
      message: 'node-pty spawn-helper wurde nicht gefunden.',
    }
  }

  try {
    fs.chmodSync(helperPath, 0o755)
    return {
      ok: true,
      helperPath,
      message: 'node-pty spawn-helper ist ausfuehrbar.',
    }
  } catch (error) {
    return {
      ok: false,
      helperPath,
      message: error instanceof Error ? error.message : 'node-pty spawn-helper konnte nicht chmod werden.',
    }
  }
}

const dbPath = path.join(appDataDir, 'claude-mac-app.sqlite')
const jsonFallbackPath = path.join(appDataDir, 'claude-mac-app-fallback.json')
let storageMode = 'sqlite'
let storageWarning = null
let migrationStatus = { ok: true, applied: [] }
let db

function openSqliteDatabase() {
  const database = new Database(dbPath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  return database
}

function backupSqliteDatabase(reason = 'schema-repair') {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const backupPath = `${dbPath}.backup-${reason}-${stamp}`
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, backupPath)
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true })
    } catch {
      // ignore cleanup errors; fallback storage will keep the runtime online
    }
  }
  return backupPath
}

if (Database) {
  try {
    db = openSqliteDatabase()
  } catch (error) {
    storageMode = 'json_fallback'
    storageWarning = {
      message: error instanceof Error ? error.message : 'better-sqlite3 konnte nicht initialisiert werden.',
      stack: error instanceof Error ? error.stack : '',
    }
    db = new JsonFileDatabase(jsonFallbackPath)
  }
} else {
  storageMode = 'json_fallback'
  storageWarning = {
    message: 'better-sqlite3 ist nicht verfuegbar. JsonFileStorage ist aktiv.',
    stack: bootstrapDiagnostics?.modules?.['better-sqlite3']?.error?.stack || '',
  }
  db = new JsonFileDatabase(jsonFallbackPath)
}

const nativeRuntimeStatus = {
  sqlite: {
    ok: storageMode === 'sqlite',
    storageMode,
    dbPath: storageMode === 'sqlite' ? dbPath : jsonFallbackPath,
    warning: storageWarning,
    bootstrap: bootstrapDiagnostics?.modules?.['better-sqlite3'] || null,
  },
  pty: {
    ok: Boolean(pty),
    helper: ensureNodePtyHelperExecutable(),
    bootstrap: bootstrapDiagnostics?.modules?.['node-pty'] || null,
  },
  bootstrap: bootstrapDiagnostics,
}

function createBaseTables(database) {
  database.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    shell TEXT,
    cwd TEXT,
    command TEXT,
    recovery_key TEXT,
    preferred INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS raw_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    chunk TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_type TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    current_task TEXT NOT NULL,
    current_tool TEXT,
    transcript_path TEXT,
    last_assistant_message TEXT,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    source_log_id TEXT
  );
  CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    total_tokens INTEGER NOT NULL,
    tokens_per_minute REAL NOT NULL,
    estimated INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    model TEXT,
    provider TEXT,
    context_window INTEGER,
    source_log_id TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS command_presets (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    start_command TEXT NOT NULL,
    start_args TEXT NOT NULL,
    env_json TEXT NOT NULL,
    description TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_runtime_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS raw_hook_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    hook_event_name TEXT NOT NULL,
    tool_name TEXT,
    agent_id TEXT,
    parent_agent_id TEXT,
    agent_type TEXT,
    transcript_path TEXT,
    agent_transcript_path TEXT,
    cwd TEXT,
    permission_mode TEXT,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hook_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    hook_event_name TEXT NOT NULL,
    tool_name TEXT,
    agent_id TEXT,
    parent_agent_id TEXT,
    agent_type TEXT,
    transcript_path TEXT,
    agent_transcript_path TEXT,
    cwd TEXT,
    permission_mode TEXT,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_id TEXT,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,
    input_summary TEXT,
    output_summary TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    error TEXT,
    raw_event_id TEXT,
    file_path TEXT
  );
  CREATE TABLE IF NOT EXISTS subagents (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    parent_agent_id TEXT,
    agent_type TEXT,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    task_prompt TEXT,
    transcript_path TEXT,
    agent_transcript_path TEXT,
    last_assistant_message TEXT,
    started_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    completed_at TEXT,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    raw_event_id TEXT
  );
  CREATE TABLE IF NOT EXISTS subagent_events (
    id TEXT PRIMARY KEY,
    subagent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_status (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_id TEXT,
    source TEXT NOT NULL,
    total_tokens INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    context_window INTEGER,
    cost_usd REAL,
    estimated INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    raw_event_id TEXT
  );
  CREATE TABLE IF NOT EXISTS file_changes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_id TEXT,
    tool_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    change_type TEXT NOT NULL,
    raw_event_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS permission_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_id TEXT,
    tool_name TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    raw_event_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_id TEXT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    raw_event_id TEXT,
    created_at TEXT NOT NULL
  );
  `)
}

createBaseTables(db)

function migrationErrorDetails(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : '',
    name: error instanceof Error ? error.name : 'MigrationError',
    details: error?.details || null,
  }
}

function runMigrationsOrFallback() {
  try {
    migrationStatus = migrateAll(db, { defaultPresets: DEFAULT_MODE_PRESETS })
    migrationStatus.schemaValidation = validateSchema(db)
    return
  } catch (error) {
    migrationStatus = {
      ok: false,
      error: migrationErrorDetails(error),
    }
    if (storageMode === 'sqlite' && error instanceof SchemaValidationError) {
      try {
        db.close?.()
      } catch {
        // ignore close errors before database repair
      }
      const backupPath = backupSqliteDatabase('schema')
      storageWarning = {
        message: 'SQLite-Schema war fehlerhaft. Die alte DB wurde gesichert und eine frische DB wurde erzeugt.',
        backupPath,
        migration: migrationStatus.error,
      }
      try {
        db = openSqliteDatabase()
        createBaseTables(db)
        migrationStatus = migrateAll(db, { defaultPresets: DEFAULT_MODE_PRESETS })
        migrationStatus.schemaValidation = validateSchema(db)
        migrationStatus.repairedFromBackup = backupPath
        return
      } catch (repairError) {
        migrationStatus = {
          ok: false,
          error: migrationErrorDetails(repairError),
          previousError: migrationErrorDetails(error),
          backupPath,
        }
      }
    }

    storageWarning = storageWarning || {
      message: 'SQLite-Migration ist fehlgeschlagen. JsonFileStorage wurde als Sicherheits-Fallback aktiviert.',
      migration: migrationStatus.error,
    }
    if (storageMode === 'sqlite') {
      try {
        db.close?.()
      } catch {
        // ignore close errors before fallback
      }
      storageMode = 'json_fallback'
      db = new JsonFileDatabase(jsonFallbackPath)
      createBaseTables(db)
      migrationStatus = migrateAll(db, { defaultPresets: DEFAULT_MODE_PRESETS })
      migrationStatus.schemaValidation = validateSchema(db)
    }
  } finally {
    nativeRuntimeStatus.sqlite.storageMode = storageMode
    nativeRuntimeStatus.sqlite.dbPath = storageMode === 'sqlite' ? dbPath : jsonFallbackPath
    nativeRuntimeStatus.sqlite.warning = storageWarning
    nativeRuntimeStatus.sqlite.migrationStatus = migrationStatus
  }
}

runMigrationsOrFallback()

const tableColumns = db.prepare(`PRAGMA table_info(sessions)`).all().map((column) => column.name)
if (!tableColumns.includes('shell')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN shell TEXT;`)
}
if (!tableColumns.includes('cwd')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN cwd TEXT;`)
}
if (!tableColumns.includes('command')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN command TEXT;`)
}
if (!tableColumns.includes('recovery_key')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN recovery_key TEXT;`)
}
if (!tableColumns.includes('preferred')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN preferred INTEGER NOT NULL DEFAULT 1;`)
}

const usageColumns = db.prepare(`PRAGMA table_info(usage_snapshots)`).all().map((column) => column.name)
if (!usageColumns.includes('model')) {
  db.exec(`ALTER TABLE usage_snapshots ADD COLUMN model TEXT;`)
}
if (!usageColumns.includes('provider')) {
  db.exec(`ALTER TABLE usage_snapshots ADD COLUMN provider TEXT;`)
}
if (!usageColumns.includes('context_window')) {
  db.exec(`ALTER TABLE usage_snapshots ADD COLUMN context_window INTEGER;`)
}
if (!usageColumns.includes('source_log_id')) {
  db.exec(`ALTER TABLE usage_snapshots ADD COLUMN source_log_id TEXT;`)
}

const agentColumns = db.prepare(`PRAGMA table_info(agents)`).all().map((column) => column.name)
if (!agentColumns.includes('source_log_id')) {
  db.exec(`ALTER TABLE agents ADD COLUMN source_log_id TEXT;`)
}

function ensureColumns(tableName, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name))
  for (const [columnName, definition] of Object.entries(columns)) {
    if (!existing.has(columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`)
    }
  }
}

ensureColumns('agents', {
  agent_type: 'TEXT',
  current_tool: 'TEXT',
  transcript_path: 'TEXT',
  last_assistant_message: 'TEXT',
})
ensureColumns('raw_hook_events', {
  agent_type: 'TEXT',
  transcript_path: 'TEXT',
  agent_transcript_path: 'TEXT',
  cwd: 'TEXT',
  permission_mode: 'TEXT',
  created_at: 'TEXT',
})
ensureColumns('hook_events', {
  agent_type: 'TEXT',
  transcript_path: 'TEXT',
  agent_transcript_path: 'TEXT',
  cwd: 'TEXT',
  permission_mode: 'TEXT',
  created_at: 'TEXT',
})
ensureColumns('subagents', {
  agent_type: 'TEXT',
  transcript_path: 'TEXT',
  agent_transcript_path: 'TEXT',
  last_assistant_message: 'TEXT',
})

const selectProjects = db.prepare(
  `SELECT id, name, path, status, created_at AS createdAt, updated_at AS updatedAt
   FROM projects ORDER BY updated_at DESC`,
)
const selectSessions = db.prepare(
  `SELECT id, project_id AS projectId, label, status, mode, started_at AS startedAt, last_activity_at AS lastActivityAt,
          shell, cwd, command, recovery_key AS recoveryKey, preferred
   FROM sessions ORDER BY last_activity_at DESC`,
)
const selectLogs = db.prepare(
  `SELECT id, session_id AS sessionId, project_id AS projectId, direction, chunk, created_at AS createdAt
   FROM raw_logs ORDER BY created_at DESC LIMIT 600`,
)
const selectAgents = db.prepare(
  `SELECT id, name, session_id AS sessionId, project_id AS projectId, status, started_at AS startedAt,
          last_activity_at AS lastActivityAt, current_task AS currentTask, current_tool AS currentTool,
          agent_type AS agentType, transcript_path AS transcriptPath, last_assistant_message AS lastAssistantMessage,
          token_estimate AS tokenEstimate, source_log_id AS sourceLogId
   FROM agents ORDER BY last_activity_at DESC`,
)
const selectUsage = db.prepare(
  `SELECT id, session_id AS sessionId, project_id AS projectId, total_tokens AS totalTokens,
          tokens_per_minute AS tokensPerMinute, estimated, captured_at AS capturedAt,
          model, provider, context_window AS contextWindow, source_log_id AS sourceLogId
   FROM usage_snapshots ORDER BY captured_at DESC LIMIT 240`,
)
const selectHookEvents = db.prepare(
  `SELECT id, session_id AS sessionId, project_id AS projectId, hook_event_name AS hookEventName,
          tool_name AS toolName, agent_id AS agentId, parent_agent_id AS parentAgentId,
          agent_type AS agentType, transcript_path AS transcriptPath, agent_transcript_path AS agentTranscriptPath,
          cwd, permission_mode AS permissionMode, timestamp, created_at AS createdAt, raw_json AS rawJson
   FROM hook_events ORDER BY timestamp DESC LIMIT 300`,
)
const selectToolCalls = db.prepare(
  `SELECT id, session_id AS sessionId, project_id AS projectId, agent_id AS agentId,
          tool_name AS toolName, status, input_summary AS inputSummary, output_summary AS outputSummary,
          started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs,
          error, raw_event_id AS rawEventId, file_path AS filePath
   FROM tool_calls ORDER BY started_at DESC LIMIT 400`,
)
const selectSubagents = db.prepare(
  `SELECT id, session_id AS sessionId, project_id AS projectId, parent_agent_id AS parentAgentId,
          agent_type AS agentType, name, status, task_prompt AS taskPrompt,
          transcript_path AS transcriptPath, agent_transcript_path AS agentTranscriptPath,
          last_assistant_message AS lastAssistantMessage, started_at AS startedAt,
          last_activity_at AS lastActivityAt, completed_at AS completedAt,
          token_estimate AS tokenEstimate, error, raw_event_id AS rawEventId
   FROM subagents ORDER BY last_activity_at DESC LIMIT 400`,
)
const selectNotifications = db.prepare(
  `SELECT id, session_id AS sessionId, project_id AS projectId, agent_id AS agentId,
          level, message, raw_event_id AS rawEventId, created_at AS createdAt
   FROM notifications ORDER BY created_at DESC LIMIT 160`,
)
const selectCommandPresets = db.prepare(
  `SELECT id, mode, label, start_command AS startCommand, start_args AS startArgs, env_json AS envJson,
          description, enabled, updated_at AS updatedAt
   FROM command_presets`,
)

const upsertSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (@key, @value)
   ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
)

const runtimeSessions = new Map()
const runtimeSchedulers = new Map()
const parsersBySession = new Map()
const RUNTIME_ACTIVE_SESSION_STATUSES = ['pending', 'diagnosing', 'spawning', 'running', 'active']
const RUNTIME_ACTIVE_STATUS_SQL = RUNTIME_ACTIVE_SESSION_STATUSES.map(() => '?').join(', ')
const wss = new WebSocketServer({ port: 0 })
const HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PermissionRequest',
  'PostToolUseFailure',
]
const TOOL_MATCHER = 'Bash|Read|Edit|MultiEdit|Write|Grep|Glob|Task|WebFetch|WebSearch|NotebookEdit|TodoWrite'
const DEFAULT_HOOK_PORT = Number(process.env.CLAUDE_MAC_HOOK_PORT || 37621)
let hookPort = null
let hookServer = null

function seedDefaultSettingsAndPresets() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key)
    if (!existing) {
      upsertSetting.run({ key, value: JSON.stringify(value) })
    }
  }

  for (const preset of DEFAULT_MODE_PRESETS) {
    const existing = db.prepare('SELECT id FROM command_presets WHERE mode = ?').get(preset.mode)
    if (!existing) {
      db.prepare(
        `INSERT INTO command_presets (id, mode, label, start_command, start_args, env_json, description, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuid(),
        preset.mode,
        preset.label,
        preset.startCommand,
        JSON.stringify(preset.startArgs),
        JSON.stringify(preset.env),
        preset.description,
        Number(preset.enabled),
        now(),
      )
    }
  }
}

seedDefaultSettingsAndPresets()

function now() {
  return new Date().toISOString()
}

function writeDaemonManifest(port) {
  fs.writeFileSync(
    daemonManifestPath,
    JSON.stringify(
      {
        pid: process.pid,
        port,
        hookPort,
        appDataDir,
        dbPath,
        updatedAt: now(),
      },
      null,
      2,
    ),
  )
}

function readSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const mapped = rows.reduce((acc, row) => {
    acc[row.key] = JSON.parse(row.value)
    return acc
  }, {})

  return {
    ...DEFAULT_SETTINGS,
    ...mapped,
    sqlitePath: dbPath,
  }
}

function listProjects() {
  return selectProjects.all()
}

function listSessions() {
  return selectSessions.all()
}

function listLogs() {
  return selectLogs.all()
}

function listAgents() {
  return selectAgents.all()
}

function listUsageSnapshots() {
  return selectUsage.all().map((snapshot) => ({
    ...snapshot,
    estimated: Boolean(snapshot.estimated),
  }))
}

function listHookEvents() {
  return selectHookEvents.all()
}

function listToolCalls() {
  return selectToolCalls.all()
}

function listSubagents() {
  return selectSubagents.all()
}

function listNotifications() {
  return selectNotifications.all()
}

function hookStatus() {
  const rawCount = db.prepare('SELECT COUNT(*) AS count FROM raw_hook_events').get()?.count ?? 0
  return {
    running: Boolean(hookPort),
    port: hookPort,
    url: hookPort ? `http://127.0.0.1:${hookPort}/hooks/claude` : '',
    statusUrl: hookPort ? `http://127.0.0.1:${hookPort}/hooks/status` : '',
    eventsReceived: Number(rawCount),
    supportedEvents: HOOK_EVENTS,
    toolMatcher: TOOL_MATCHER,
  }
}

function listCommandPresets() {
  return sortModePresets(
    selectCommandPresets.all().map((preset) => ({
      ...preset,
      startArgs: JSON.parse(preset.startArgs),
      env: JSON.parse(preset.envJson),
      enabled: Boolean(preset.enabled),
    })),
  )
}

function snapshot() {
  return {
    projects: listProjects(),
    sessions: listSessions(),
    agents: listAgents(),
    usageSnapshots: listUsageSnapshots(),
    hookEvents: listHookEvents(),
    toolCalls: listToolCalls(),
    subagents: listSubagents(),
    notifications: listNotifications(),
    hookStatus: hookStatus(),
    rawLogs: listLogs(),
    settings: readSettings(),
    commandPresets: listCommandPresets(),
  }
}

function broadcast(type, payload) {
  const encoded = JSON.stringify({ type, payload })
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(encoded)
    }
  }
}

function appendRuntimeLog(eventType, payload = {}) {
  const createdAt = now()
  const chunk = JSON.stringify({ eventType, ...payload, at: createdAt })
  appendLog('runtime', 'runtime', 'event', chunk)
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : 'runtime'
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : 'runtime'
  db.prepare(
    `INSERT INTO session_runtime_events (id, session_id, project_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), sessionId, projectId, eventType, JSON.stringify(payload), createdAt)
  broadcast('runtime_event', { eventType, payload, createdAt })
}

function emitAll() {
  broadcast('projects_updated', listProjects())
  broadcast('sessions_updated', listSessions())
  broadcast('agents_updated', listAgents())
  broadcast('usage_updated', listUsageSnapshots())
  broadcast('hook_events_updated', listHookEvents())
  broadcast('tool_calls_updated', listToolCalls())
  broadcast('subagents_updated', listSubagents())
  broadcast('notifications_updated', listNotifications())
  broadcast('hook_status_updated', hookStatus())
  broadcast('logs_updated', listLogs())
  broadcast('settings_updated', readSettings())
  broadcast('command_presets_updated', listCommandPresets())
}

function appendLog(sessionId, projectId, direction, chunk) {
  const logId = uuid()
  db.prepare(
    `INSERT INTO raw_logs (id, session_id, project_id, direction, chunk, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(logId, sessionId, projectId, direction, chunk, now())
  return logId
}

function appendSessionEvent(sessionId, projectId, eventType, payload) {
  db.prepare(
    `INSERT INTO session_events (id, session_id, project_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), sessionId, projectId, eventType, JSON.stringify(payload), now())
}

function updateSessionLifecycle(sessionId, projectId, status, payload = {}) {
  db.prepare('UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?').run(status, now(), sessionId)
  appendSessionEvent(sessionId, projectId, status, payload)
  broadcast('session_lifecycle', { sessionId, projectId, status, payload, createdAt: now() })
}

function broadcastStartProgress(step, payload = {}) {
  const eventPayload = {
    step,
    ...payload,
  }
  appendRuntimeLog(`start_${step}`, eventPayload)
  broadcast('start_progress', {
    ...eventPayload,
    createdAt: now(),
  })
}

function ensureParserState(sessionId) {
  if (!parsersBySession.has(sessionId)) {
    parsersBySession.set(sessionId, {
      agentParser: new AgentParser(),
      usageParser: new UsageParser(),
    })
  }
  return parsersBySession.get(sessionId)
}

function resolveModePreset(mode) {
  const preset = db
    .prepare(
      `SELECT id, mode, label, start_command AS startCommand, start_args AS startArgs, env_json AS envJson,
              description, enabled
       FROM command_presets WHERE mode = ?`,
    )
    .get(mode)

  if (!preset) {
    throw new Error(`Kein Command Preset fuer Modus "${mode}" gefunden.`)
  }

  return {
    ...preset,
    startArgs: JSON.parse(preset.startArgs),
    env: JSON.parse(preset.envJson),
    enabled: Boolean(preset.enabled),
  }
}

function updateAgentFromEvent(agentEvent) {
  const existing = db.prepare('SELECT id, started_at AS startedAt FROM agents WHERE id = ?').get(agentEvent.agent.id)
  const timestamp = now()

  if (!existing) {
    db.prepare(
      `INSERT INTO agents (id, name, session_id, project_id, status, started_at, last_activity_at, current_task, token_estimate, source_log_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentEvent.agent.id,
      agentEvent.agent.name,
      agentEvent.agent.sessionId,
      agentEvent.agent.projectId,
      agentEvent.agent.status,
      timestamp,
      timestamp,
      agentEvent.agent.currentTask,
      0,
      agentEvent.agent.sourceLogId,
    )
  } else {
    db.prepare(
      `UPDATE agents
       SET status = ?, current_task = ?, last_activity_at = ?, source_log_id = ?
       WHERE id = ?`,
    ).run(
      agentEvent.agent.status,
      agentEvent.agent.currentTask,
      timestamp,
      agentEvent.agent.sourceLogId,
      agentEvent.agent.id,
    )
  }

  db.prepare(
    `INSERT INTO agent_events (id, agent_id, session_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    agentEvent.agent.id,
    agentEvent.agent.sessionId,
    agentEvent.type,
    JSON.stringify(agentEvent.agent),
    timestamp,
  )

  if (agentEvent.type === 'agent_spawned') {
    broadcast('agent_detected', agentEvent.agent)
  }
}

function insertUsageSnapshot(event) {
  db.prepare(
    `INSERT INTO usage_snapshots (id, session_id, project_id, total_tokens, tokens_per_minute, estimated, captured_at, model, provider, context_window, source_log_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    event.snapshot.sessionId,
    event.snapshot.projectId,
    event.snapshot.totalTokens,
    event.snapshot.tokensPerMinute,
    Number(event.snapshot.estimated),
    now(),
    event.snapshot.model,
    event.snapshot.provider,
    event.snapshot.contextWindow,
    event.snapshot.sourceLogId,
  )
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value ?? '')).digest('hex').slice(0, 16)
}

function truncate(value, length = 280) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function summarizeToolInput(toolName, input = {}) {
  if (!input || typeof input !== 'object') {
    return truncate(input)
  }
  if (toolName === 'Bash') {
    return truncate(input.command || input.description || input)
  }
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return truncate(input.file_path || input.path || input.command || input)
  }
  if (toolName === 'Grep') {
    return truncate(`${input.pattern || ''} ${input.path || ''}`.trim() || input)
  }
  if (toolName === 'Glob') {
    return truncate(`${input.pattern || ''} ${input.path || ''}`.trim() || input)
  }
  if (toolName === 'Task') {
    return truncate(input.description || input.prompt || input.task || input)
  }
  return truncate(input)
}

function summarizeToolOutput(output = {}) {
  if (!output) {
    return ''
  }
  if (typeof output === 'string') {
    return truncate(output)
  }
  return truncate(output.summary || output.result || output.output || output.content || output)
}

function extractFilePath(toolName, input = {}, output = {}) {
  if (!input || typeof input !== 'object') {
    return ''
  }
  return (
    input.file_path ||
    input.path ||
    output?.filePath ||
    output?.file_path ||
    (toolName === 'Bash' ? '' : '')
  )
}

function resolveProjectForHook(payload = {}) {
  const cwd = payload.cwd || process.cwd()
  const projects = listProjects()
  const matched = projects
    .filter((project) => cwd === project.path || cwd.startsWith(`${project.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]

  if (matched) {
    return matched
  }

  return {
    id: createProject({
      name: cwd.split('/').filter(Boolean).at(-1) || 'Claude Hook Project',
      path: cwd,
    }),
    path: cwd,
  }
}

function resolveSessionForHook(payload, projectId) {
  const hookSessionId = payload.session_id || `hook-${projectId}`
  const linked = db
    .prepare(`SELECT id FROM sessions WHERE project_id = ? AND recovery_key = ? ORDER BY last_activity_at DESC LIMIT 1`)
    .get(projectId, hookSessionId)
  if (linked?.id) {
    return linked.id
  }

  const active = db
    .prepare(
      `SELECT id FROM sessions
       WHERE project_id = ? AND status IN ('pending', 'diagnosing', 'spawning', 'running', 'active')
       ORDER BY last_activity_at DESC LIMIT 1`,
    )
    .get(projectId)
  if (active?.id) {
    db.prepare('UPDATE sessions SET recovery_key = ?, last_activity_at = ? WHERE id = ?').run(hookSessionId, now(), active.id)
    return active.id
  }

  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(hookSessionId)
  if (existing?.id) {
    return existing.id
  }

  const timestamp = now()
  db.prepare(
    `INSERT INTO sessions (id, project_id, label, status, mode, started_at, last_activity_at, shell, cwd, command, recovery_key, preferred)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hookSessionId,
    projectId,
    `Claude Hook Session · ${new Date().toLocaleTimeString()}`,
    'running',
    readSettings().defaultMode,
    timestamp,
    timestamp,
    'hook',
    payload.cwd || process.cwd(),
    'claudestart',
    hookSessionId,
    1,
  )
  return hookSessionId
}

function toolCallIdForHook(payload, sessionId) {
  return payload.tool_use_id || payload.tool_call_id || `${sessionId}:${payload.agent_id || 'root'}:${payload.tool_name || 'tool'}:${stableHash(payload.tool_input)}`
}

function subagentIdForTask(payload, sessionId) {
  return payload.agent_id || payload.tool_use_id || payload.tool_call_id || `${sessionId}:task:${stableHash(payload.tool_input)}`
}

function rootAgentId(sessionId) {
  return `${sessionId}:root`
}

function hookMetadata(payload = {}) {
  const lastAssistantMessage =
    payload.last_assistant_message ||
    payload.lastAssistantMessage ||
    payload.message?.content ||
    (typeof payload.message === 'string' ? payload.message : null)
  return {
    agentType: payload.agent_type || payload.subagent_type || payload.tool_input?.subagent_type || null,
    transcriptPath: payload.transcript_path || payload.transcriptPath || null,
    agentTranscriptPath: payload.agent_transcript_path || payload.agentTranscriptPath || null,
    cwd: payload.cwd || null,
    permissionMode: payload.permission_mode || payload.permissionMode || null,
    lastAssistantMessage: lastAssistantMessage ? truncate(lastAssistantMessage, 1000) : null,
  }
}

function upsertAgentCard({
  id,
  name,
  sessionId,
  projectId,
  status,
  currentTask,
  currentTool = null,
  agentType = null,
  transcriptPath = null,
  lastAssistantMessage = null,
  sourceLogId,
  tokenEstimate = 0,
}) {
  const timestamp = now()
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id)
  if (!existing) {
    db.prepare(
      `INSERT INTO agents (id, name, session_id, project_id, agent_type, status, started_at, last_activity_at, current_task, current_tool, transcript_path, last_assistant_message, token_estimate, source_log_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      sessionId,
      projectId,
      agentType,
      status,
      timestamp,
      timestamp,
      currentTask || '',
      currentTool,
      transcriptPath,
      lastAssistantMessage,
      tokenEstimate,
      sourceLogId,
    )
    broadcast('agent_detected', {
      id,
      name,
      sessionId,
      projectId,
      agentType,
      status,
      startedAt: timestamp,
      lastActivityAt: timestamp,
      currentTask: currentTask || '',
      currentTool,
      transcriptPath,
      lastAssistantMessage,
      tokenEstimate,
      sourceLogId,
    })
    return
  }

  db.prepare(
    `UPDATE agents
     SET name = ?, agent_type = COALESCE(?, agent_type), status = ?, current_task = COALESCE(NULLIF(?, ''), current_task),
         current_tool = COALESCE(?, current_tool), transcript_path = COALESCE(?, transcript_path),
         last_assistant_message = COALESCE(?, last_assistant_message),
         last_activity_at = ?, token_estimate = COALESCE(?, token_estimate), source_log_id = COALESCE(?, source_log_id)
     WHERE id = ?`,
  ).run(
    name,
    agentType,
    status,
    currentTask || '',
    currentTool,
    transcriptPath,
    lastAssistantMessage,
    timestamp,
    tokenEstimate,
    sourceLogId,
    id,
  )
}

function upsertSubagent({
  id,
  sessionId,
  projectId,
  parentAgentId,
  agentType = null,
  name,
  status,
  taskPrompt,
  transcriptPath = null,
  agentTranscriptPath = null,
  lastAssistantMessage = null,
  rawEventId,
  error = null,
}) {
  const timestamp = now()
  const existing = db.prepare('SELECT id, started_at AS startedAt FROM subagents WHERE id = ?').get(id)
  if (!existing) {
    db.prepare(
      `INSERT INTO subagents (id, session_id, project_id, parent_agent_id, agent_type, name, status, task_prompt, transcript_path, agent_transcript_path, last_assistant_message, started_at, last_activity_at, completed_at, token_estimate, error, raw_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionId,
      projectId,
      parentAgentId || null,
      agentType,
      name,
      status,
      taskPrompt || '',
      transcriptPath,
      agentTranscriptPath,
      lastAssistantMessage,
      timestamp,
      timestamp,
      status === 'completed' || status === 'failed' ? timestamp : null,
      0,
      error,
      rawEventId,
    )
  } else {
    db.prepare(
      `UPDATE subagents
       SET name = ?, agent_type = COALESCE(?, agent_type), status = ?, task_prompt = COALESCE(NULLIF(?, ''), task_prompt),
           transcript_path = COALESCE(?, transcript_path), agent_transcript_path = COALESCE(?, agent_transcript_path),
           last_assistant_message = COALESCE(?, last_assistant_message),
           last_activity_at = ?, completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END,
           error = COALESCE(?, error), raw_event_id = ?
       WHERE id = ?`,
    ).run(
      name,
      agentType,
      status,
      taskPrompt || '',
      transcriptPath,
      agentTranscriptPath,
      lastAssistantMessage,
      timestamp,
      status,
      timestamp,
      error,
      rawEventId,
      id,
    )
  }

  db.prepare(
    `INSERT INTO subagent_events (id, subagent_id, session_id, project_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), id, sessionId, projectId, status, JSON.stringify({ name, agentType, taskPrompt, transcriptPath, agentTranscriptPath, lastAssistantMessage, error }), timestamp)

  upsertAgentCard({
    id,
    name,
    sessionId,
    projectId,
    status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'running',
    currentTask: taskPrompt || '',
    agentType,
    transcriptPath: agentTranscriptPath || transcriptPath,
    lastAssistantMessage,
    sourceLogId: rawEventId,
  })
}

function recordSessionStatus(sessionId, projectId, status, source, payload = {}) {
  db.prepare(
    `INSERT INTO session_status (id, session_id, project_id, status, source, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), sessionId, projectId, status, source, JSON.stringify(payload), now())
  if (source === 'SessionStart') {
    db.prepare('UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?').run('running', now(), sessionId)
  }
  if (source === 'Stop') {
    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now(), sessionId)
  }
}

function recordToolCall(payload, context) {
  const { sessionId, projectId, rawEventId } = context
  const eventName = payload.hook_event_name || 'Hook'
  const toolName = payload.tool_name || 'unknown'
  const agentId = payload.agent_id || null
  const id = toolCallIdForHook(payload, sessionId)
  const timestamp = now()
  const metadata = hookMetadata(payload)
  const inputSummary = summarizeToolInput(toolName, payload.tool_input)
  const outputSummary = summarizeToolOutput(payload.tool_response)
  const filePath = extractFilePath(toolName, payload.tool_input, payload.tool_response)
  const isFailure = eventName === 'PostToolUseFailure' || payload.tool_response?.is_error || payload.tool_response?.error
  const status = eventName === 'PreToolUse' ? 'running' : isFailure ? 'failed' : 'completed'
  const existing = db.prepare('SELECT id, started_at AS startedAt FROM tool_calls WHERE id = ?').get(id)

  if (!existing) {
    db.prepare(
      `INSERT INTO tool_calls (id, session_id, project_id, agent_id, tool_name, status, input_summary, output_summary, started_at, completed_at, duration_ms, error, raw_event_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionId,
      projectId,
      agentId,
      toolName,
      status,
      inputSummary,
      outputSummary,
      timestamp,
      status === 'running' ? null : timestamp,
      null,
      isFailure ? outputSummary || 'Tool failed' : null,
      rawEventId,
      filePath || null,
    )
  } else {
    const durationMs = Math.max(0, new Date(timestamp).getTime() - new Date(existing.startedAt).getTime())
    db.prepare(
      `UPDATE tool_calls
       SET status = ?, output_summary = COALESCE(NULLIF(?, ''), output_summary), completed_at = ?,
           duration_ms = ?, error = ?, raw_event_id = ?, file_path = COALESCE(NULLIF(?, ''), file_path)
       WHERE id = ?`,
    ).run(
      status,
      outputSummary,
      status === 'running' ? null : timestamp,
      status === 'running' ? null : durationMs,
      isFailure ? outputSummary || 'Tool failed' : null,
      rawEventId,
      filePath || '',
      id,
    )
  }

  appendRuntimeLog(eventName === 'PreToolUse' ? 'tool_call_started' : 'tool_call_completed', {
    sessionId,
    projectId,
    agentId,
    toolName,
    status,
  })
  appendRuntimeLog('tool_call_detected', { sessionId, projectId, agentId, toolName, status })

  if (!agentId) {
    upsertAgentCard({
      id: rootAgentId(sessionId),
      name: 'Root Claude Session',
      sessionId,
      projectId,
      status: status === 'failed' ? 'failed' : 'running',
      currentTask: inputSummary || `Tool: ${toolName}`,
      currentTool: status === 'running' ? toolName : 'idle',
      agentType: 'root',
      transcriptPath: metadata.transcriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      sourceLogId: rawEventId,
    })
  }

  if (filePath && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    db.prepare(
      `INSERT INTO file_changes (id, session_id, project_id, agent_id, tool_name, file_path, change_type, raw_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuid(), sessionId, projectId, agentId, toolName, filePath, toolName.toLowerCase(), rawEventId, timestamp)
  }

  if (toolName === 'Task') {
    const taskPrompt = payload.tool_input?.prompt || payload.tool_input?.description || payload.tool_input?.task || inputSummary
    const subagentId = subagentIdForTask(payload, sessionId)
    upsertSubagent({
      id: subagentId,
      sessionId,
      projectId,
      parentAgentId: agentId,
      agentType: metadata.agentType,
      name: payload.tool_input?.subagent_type || payload.tool_input?.description || 'Task Subagent',
      status: status === 'running' ? 'running' : status,
      taskPrompt,
      transcriptPath: metadata.transcriptPath,
      agentTranscriptPath: metadata.agentTranscriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      rawEventId,
      error: isFailure ? outputSummary : null,
    })
    if (eventName === 'PreToolUse') {
      appendRuntimeLog('subagent_spawned', { sessionId, projectId, subagentId, taskPrompt: truncate(taskPrompt, 160) })
      appendRuntimeLog('subagent_detected', { sessionId, projectId, subagentId, taskPrompt: truncate(taskPrompt, 160) })
    }
  }

  if (agentId) {
    upsertSubagent({
      id: agentId,
      sessionId,
      projectId,
      parentAgentId: payload.parent_agent_id || null,
      agentType: metadata.agentType,
      name: payload.agent_type || 'Subagent',
      status: eventName === 'SubagentStop' ? 'completed' : 'running',
      taskPrompt: inputSummary,
      transcriptPath: metadata.transcriptPath,
      agentTranscriptPath: metadata.agentTranscriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      rawEventId,
      error: isFailure ? outputSummary : null,
    })
    upsertAgentCard({
      id: agentId,
      name: payload.agent_type || 'Subagent',
      sessionId,
      projectId,
      status: status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'running',
      currentTask: inputSummary,
      currentTool: status === 'running' ? toolName : 'idle',
      agentType: metadata.agentType,
      transcriptPath: metadata.agentTranscriptPath || metadata.transcriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      sourceLogId: rawEventId,
    })
  }
}

function findUsageObject(payload) {
  const candidates = [
    payload.usage,
    payload.message?.usage,
    payload.response?.usage,
    payload.result?.usage,
    payload.tool_response?.usage,
    payload.tool_response?.message?.usage,
  ]
  return candidates.find((candidate) => candidate && typeof candidate === 'object') || null
}

function recordUsageFromHook(payload, context) {
  const usage = findUsageObject(payload)
  if (!usage) {
    return
  }

  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? 0)
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? 0)
  const cacheRead = Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0)
  const cacheCreate = Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0)
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens + cacheRead + cacheCreate)
  const timestamp = now()

  db.prepare(
    `INSERT INTO token_usage (id, session_id, project_id, agent_id, source, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, context_window, cost_usd, estimated, captured_at, raw_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    context.sessionId,
    context.projectId,
    payload.agent_id || null,
    'hook',
    totalTokens,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheCreate,
    Number(usage.context_window ?? usage.contextWindow ?? 0) || null,
    0,
    0,
    timestamp,
    context.rawEventId,
  )

  insertUsageSnapshot({
    snapshot: {
      sessionId: context.sessionId,
      projectId: context.projectId,
      totalTokens,
      tokensPerMinute: 0,
      estimated: false,
      model: payload.model || payload.message?.model || null,
      provider: 'LM Studio / lokal / 0 EUR',
      contextWindow: Number(usage.context_window ?? usage.contextWindow ?? 0) || null,
      sourceLogId: context.rawEventId,
    },
  })
  appendRuntimeLog('token_update', { sessionId: context.sessionId, projectId: context.projectId, totalTokens, source: 'hook' })
  broadcast('token_update', { sessionId: context.sessionId, projectId: context.projectId, totalTokens, estimated: false })
}

function recordNotification(payload, context) {
  const message = payload.message || payload.notification || payload.reason || payload.text || summarizeToolOutput(payload)
  db.prepare(
    `INSERT INTO notifications (id, session_id, project_id, agent_id, level, message, raw_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    context.sessionId,
    context.projectId,
    payload.agent_id || null,
    payload.level || payload.type || 'info',
    truncate(message, 800),
    context.rawEventId,
    now(),
  )
}

function recordPermissionRequest(payload, context) {
  db.prepare(
    `INSERT INTO permission_requests (id, session_id, project_id, agent_id, tool_name, status, reason, raw_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    context.sessionId,
    context.projectId,
    payload.agent_id || null,
    payload.tool_name || null,
    payload.decision || payload.permissionDecision || 'waiting',
    payload.reason || payload.permissionDecisionReason || '',
    context.rawEventId,
    now(),
  )
}

function handleClaudeHookEvent(payload = {}) {
  const hookEventName = payload.hook_event_name || payload.event || 'unknown'
  const project = resolveProjectForHook(payload)
  const projectId = project.id
  const sessionId = resolveSessionForHook(payload, projectId)
  const rawEventId = uuid()
  const timestamp = now()
  const rawJson = JSON.stringify(payload)
  const toolName = payload.tool_name || null
  const agentId = payload.agent_id || null
  const parentAgentId = payload.parent_agent_id || null
  const metadata = hookMetadata(payload)

  for (const table of ['raw_hook_events', 'hook_events']) {
    db.prepare(
      `INSERT INTO ${table} (id, session_id, project_id, hook_event_name, tool_name, agent_id, parent_agent_id, agent_type, transcript_path, agent_transcript_path, cwd, permission_mode, timestamp, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rawEventId,
      sessionId,
      projectId,
      hookEventName,
      toolName,
      agentId,
      parentAgentId,
      metadata.agentType,
      metadata.transcriptPath,
      metadata.agentTranscriptPath,
      metadata.cwd,
      metadata.permissionMode,
      timestamp,
      timestamp,
      rawJson,
    )
  }

  appendRuntimeLog('hook_event_received', { sessionId, projectId, hookEventName, toolName, agentId })

  if (hookEventName === 'SessionStart') {
    recordSessionStatus(sessionId, projectId, 'running', hookEventName, payload)
    upsertAgentCard({
      id: agentId || rootAgentId(sessionId),
      name: metadata.agentType || 'Root Claude Session',
      sessionId,
      projectId,
      status: 'running',
      currentTask: truncate(payload.source || payload.message || 'Claude Code Session gestartet', 600),
      agentType: metadata.agentType || 'root',
      transcriptPath: metadata.transcriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      sourceLogId: rawEventId,
    })
  }
  if (hookEventName === 'Stop') {
    recordSessionStatus(sessionId, projectId, 'idle', hookEventName, payload)
    upsertAgentCard({
      id: agentId || rootAgentId(sessionId),
      name: metadata.agentType || 'Root Claude Session',
      sessionId,
      projectId,
      status: payload.error ? 'failed' : 'completed',
      currentTask: payload.error ? truncate(payload.error, 300) : 'Claude wartet auf die nächste Aufgabe',
      agentType: metadata.agentType || 'root',
      transcriptPath: metadata.transcriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      sourceLogId: rawEventId,
    })
  }
  if (hookEventName === 'PreCompact') {
    recordSessionStatus(sessionId, projectId, 'compacting', hookEventName, payload)
  }
  if (hookEventName === 'Notification') {
    recordNotification(payload, { sessionId, projectId, rawEventId })
    upsertAgentCard({
      id: agentId || rootAgentId(sessionId),
      name: metadata.agentType || (agentId ? 'Subagent' : 'Root Claude Session'),
      sessionId,
      projectId,
      status: 'waiting',
      currentTask: truncate(payload.message || payload.notification || payload.reason || 'Claude wartet auf eine Aktion', 600),
      agentType: metadata.agentType || (agentId ? 'subagent' : 'root'),
      transcriptPath: metadata.agentTranscriptPath || metadata.transcriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      sourceLogId: rawEventId,
    })
  }
  if (hookEventName === 'UserPromptSubmit') {
    upsertAgentCard({
      id: agentId || rootAgentId(sessionId),
      name: metadata.agentType || 'Root Claude Session',
      sessionId,
      projectId,
      status: 'running',
      currentTask: truncate(payload.prompt || payload.message || 'User prompt submitted', 600),
      agentType: metadata.agentType || 'root',
      transcriptPath: metadata.transcriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      sourceLogId: rawEventId,
    })
  }
  if (hookEventName === 'PermissionRequest') {
    recordPermissionRequest(payload, { sessionId, projectId, rawEventId })
    upsertAgentCard({
      id: agentId || rootAgentId(sessionId),
      name: metadata.agentType || (agentId ? 'Subagent' : 'Root Claude Session'),
      sessionId,
      projectId,
      status: 'waiting',
      currentTask: truncate(payload.reason || payload.permissionDecisionReason || `Wartet auf Freigabe fuer ${toolName || 'Tool'}`, 600),
      currentTool: toolName,
      agentType: metadata.agentType || (agentId ? 'subagent' : 'root'),
      transcriptPath: metadata.agentTranscriptPath || metadata.transcriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      sourceLogId: rawEventId,
    })
  }
  if (hookEventName === 'PreToolUse' || hookEventName === 'PostToolUse' || hookEventName === 'PostToolUseFailure') {
    recordToolCall(payload, { sessionId, projectId, rawEventId })
  }
  if (hookEventName === 'SubagentStop') {
    const fallbackAgent = agentId
      ? null
      : db
          .prepare(`SELECT id FROM subagents WHERE session_id = ? AND status = 'running' ORDER BY last_activity_at DESC LIMIT 1`)
          .get(sessionId)
    const stopAgentId = agentId || fallbackAgent?.id
    if (!stopAgentId) {
      appendRuntimeLog('subagent_completed', { sessionId, projectId, agentId: null, unresolved: true })
    } else {
    upsertSubagent({
      id: stopAgentId,
      sessionId,
      projectId,
      parentAgentId,
      agentType: metadata.agentType,
      name: payload.agent_type || 'Subagent',
      status: payload.error ? 'failed' : 'completed',
      taskPrompt: payload.summary || payload.reason || '',
      transcriptPath: metadata.transcriptPath,
      agentTranscriptPath: metadata.agentTranscriptPath,
      lastAssistantMessage: metadata.lastAssistantMessage,
      rawEventId,
      error: payload.error || null,
    })
      appendRuntimeLog('subagent_completed', { sessionId, projectId, agentId: stopAgentId, status: payload.error ? 'failed' : 'completed' })
    }
  }

  recordUsageFromHook(payload, { sessionId, projectId, rawEventId })
  emitAll()
  return { rawEventId, sessionId, projectId, hookEventName }
}

function consumeParsers(sessionId, projectId, chunk, logId) {
  const parserState = ensureParserState(sessionId)
  const context = { sessionId, projectId, logId }

  for (const event of parserState.agentParser.ingest(chunk, context)) {
    updateAgentFromEvent(event)
  }

  for (const event of parserState.usageParser.ingest(chunk, context)) {
    insertUsageSnapshot(event)
  }
}

function clearStatusPoll(sessionId) {
  const existing = runtimeSchedulers.get(sessionId)
  if (existing) {
    clearInterval(existing)
    runtimeSchedulers.delete(sessionId)
  }
}

function scheduleStatusPoll(sessionId) {
  clearStatusPoll(sessionId)
  const settings = readSettings()
  if (!settings.autoStatusPollEnabled) {
    return
  }

  const intervalMs = Math.max(1, Number(settings.autoStatusPollMinutes) || 5) * 60_000
  const timer = setInterval(() => {
    sendInput(sessionId, '/status', { silent: true })
  }, intervalMs)
  runtimeSchedulers.set(sessionId, timer)
}

function getActiveSessionForProject(projectId) {
  const rows = db
    .prepare(
      `SELECT id, project_id AS projectId, status
       FROM sessions
       WHERE project_id = ? AND status IN (${RUNTIME_ACTIVE_STATUS_SQL})
       ORDER BY started_at DESC`,
    )
    .all(projectId, ...RUNTIME_ACTIVE_SESSION_STATUSES)
  let reapedStaleSession = false

  for (const row of rows) {
    if (runtimeSessions.has(row.id)) {
      return row
    }
    markSessionStale(row, 'start_requested_without_runtime_pty')
    reapedStaleSession = true
  }

  if (reapedStaleSession) {
    emitAll()
  }

  return null
}

function markSessionStale(row, reason) {
  db.prepare('UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?').run('ended', now(), row.id)
  appendSessionEvent(row.id, row.projectId, 'session_stopped', {
    stale: true,
    reason,
    previousStatus: row.status,
  })
  appendRuntimeLog('stale_session_reaped', {
    sessionId: row.id,
    projectId: row.projectId,
    previousStatus: row.status,
    reason,
  })
}

function persistModePreset(payload) {
  const existing = db.prepare('SELECT id FROM command_presets WHERE mode = ?').get(payload.mode)
  const id = existing?.id || uuid()

  db.prepare(
    `INSERT INTO command_presets (id, mode, label, start_command, start_args, env_json, description, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mode) DO UPDATE SET
       label = excluded.label,
       start_command = excluded.start_command,
       start_args = excluded.start_args,
       env_json = excluded.env_json,
       description = excluded.description,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    payload.mode,
    payload.label,
    payload.startCommand,
    JSON.stringify(payload.startArgs || []),
    JSON.stringify(payload.env || {}),
    payload.description || '',
    Number(payload.enabled !== false),
    now(),
  )
}

function buildSessionLabel(project, mode) {
  return `${project.name} · ${mode} · ${new Date().toLocaleTimeString()}`
}

function buildSpawnEnvironment(preset) {
  return {
    ...process.env,
    ...preset.env,
    TERM: 'xterm-256color',
    CLAUDE_MAC_APP: '1',
  }
}

function buildUserFacingStartError(startDiagnostic, startCommand) {
  return {
    message: `Startbefehl "${startCommand}" wurde in deiner Terminal-Umgebung nicht gefunden.`,
    shell: startDiagnostic.shell,
    path: startDiagnostic.path,
    cwd: startDiagnostic.cwd,
    home: startDiagnostic.home,
    user: startDiagnostic.user,
    which: startDiagnostic.which,
    commandV: startDiagnostic.commandV,
    typeResult: startDiagnostic.type || '(keine Ausgabe)',
    stdout: startDiagnostic.stdout,
    stderr: startDiagnostic.stderr,
    exitCode: startDiagnostic.exitCode,
    shellFiles: startDiagnostic.shellFiles,
    candidates: startDiagnostic.candidates,
    finalStartCommand: startCommand,
    suggestion:
      'Pruefe, ob dein Alias/Funktion in deiner Login-Shell geladen wird. Alternativ kannst du im Preset den direkten Skriptpfad eintragen.',
  }
}

function spawnSession(project, options = {}) {
  const settings = readSettings()
  const mode = options.mode || settings.defaultMode
  const preset = resolveModePreset(mode)
  if (!preset.enabled) {
    throw new Error(`Das Preset fuer ${mode} ist deaktiviert.`)
  }

  const existingActive = getActiveSessionForProject(project.id)
  if (existingActive && !settings.allowMultipleSessionsPerProject && !options.forceNewSession) {
    broadcast('session_conflict', {
      projectId: project.id,
      sessionId: existingActive.id,
      message: 'Fuer dieses Projekt existiert bereits eine aktive Session.',
    })
    return existingActive.id
  }

  const sessionId = uuid()
  const startedAt = now()
  const label = buildSessionLabel(project, mode)
  const spawnEnv = buildSpawnEnvironment(preset)
  const initialCommand = buildStartCommand(preset)
  broadcastStartProgress('request_received', { sessionId, projectId: project.id, mode, command: initialCommand })
  broadcastStartProgress('project_checked', { sessionId, projectId: project.id, cwd: project.path })
  appendRuntimeLog('start_session_requested', { sessionId, projectId: project.id, mode, command: initialCommand })
  appendRuntimeLog('start_requested', { sessionId, projectId: project.id, mode, command: initialCommand })

  db.prepare(
    `INSERT INTO sessions (id, project_id, label, status, mode, started_at, last_activity_at, shell, cwd, command, recovery_key, preferred)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    project.id,
    label,
    'pending',
    mode,
    startedAt,
    startedAt,
    getShellPath(spawnEnv),
    project.path,
    initialCommand,
    `${project.id}:${mode}`,
    options.preferred === false ? 0 : 1,
  )

  updateSessionLifecycle(sessionId, project.id, 'diagnosing', { command: initialCommand })
  broadcastStartProgress('claudestart_diagnosing', { sessionId, projectId: project.id, cwd: project.path, command: preset.startCommand })
  appendRuntimeLog('shell_diagnostic_started', { sessionId, projectId: project.id, command: preset.startCommand })
  const invocation = resolveStartInvocation(preset, project.path, spawnEnv)
  appendRuntimeLog('shell_diagnostic_finished', {
    sessionId,
    projectId: project.id,
    ok: invocation.ok,
    resolution: invocation.diagnostic.resolution,
  })
  broadcast('diagnostic_result', {
    kind: 'claudestart',
    sessionId,
    projectId: project.id,
    result: {
      ...invocation.diagnostic,
      finalStartCommand: invocation.finalCommand,
      finalPtyCommand: invocation.ptyCommand,
      ok: invocation.ok,
      suggestion: invocation.suggestion,
    },
  })

  if (!invocation.ok) {
    const errorPayload = buildUserFacingStartError(invocation.diagnostic, preset.startCommand)
    updateSessionLifecycle(sessionId, project.id, 'failed', errorPayload)
    appendRuntimeLog('claudestart_not_found', {
      sessionId,
      projectId: project.id,
      shell: invocation.diagnostic.shell,
      path: invocation.diagnostic.path,
      type: invocation.diagnostic.type,
    })
    broadcastStartProgress('failed', {
      sessionId,
      projectId: project.id,
      message: errorPayload.message,
      resolution: invocation.diagnostic.resolution,
    })
    appendRuntimeLog('start_failed', { sessionId, projectId: project.id, reason: 'command_not_found' })
    emitAll()
    broadcast('error', errorPayload)
    return null
  }

  appendRuntimeLog('claudestart_found', {
    sessionId,
    projectId: project.id,
    resolution: invocation.diagnostic.resolution,
    finalStartCommand: invocation.finalCommand,
    finalPtyCommand: invocation.ptyCommand,
  })
  broadcastStartProgress('claudestart_found', {
    sessionId,
    projectId: project.id,
    resolution: invocation.diagnostic.resolution,
    finalStartCommand: invocation.finalCommand,
    finalPtyCommand: invocation.ptyCommand,
  })

  if (!pty) {
    const errorPayload = {
      message: 'node-pty ist in dieser Runtime nicht verfuegbar. Claude Code kann nicht als interaktiver PTY gestartet werden.',
      nativeRuntimeStatus,
      finalStartCommand: invocation.finalCommand,
      finalPtyCommand: invocation.ptyCommand,
      suggestion:
        'Fuehre npm run sidecar:prepare aus und pruefe .sidecar-bundle/diagnostics.json. Wenn spawn-helper fehlt oder nicht ausfuehrbar ist: npm run sidecar:rebuild-native.',
    }
    updateSessionLifecycle(sessionId, project.id, 'failed', errorPayload)
    broadcastStartProgress('failed', { sessionId, projectId: project.id, message: errorPayload.message })
    appendRuntimeLog('start_failed', { sessionId, projectId: project.id, reason: 'node_pty_unavailable', nativeRuntimeStatus })
    emitAll()
    broadcast('error', errorPayload)
    return null
  }

  updateSessionLifecycle(sessionId, project.id, 'spawning', {
    finalStartCommand: invocation.finalCommand,
    finalPtyCommand: invocation.ptyCommand,
    resolution: invocation.diagnostic.resolution,
  })
  appendRuntimeLog('pty_spawn_requested', {
    sessionId,
    projectId: project.id,
    ptyFile: invocation.ptyFile,
    ptyArgs: invocation.ptyArgs,
  })
  broadcastStartProgress('pty_spawning', {
    sessionId,
    projectId: project.id,
    ptyFile: invocation.ptyFile,
    ptyArgs: invocation.ptyArgs,
  })

  db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run('active', startedAt, project.id)

  let proc
  try {
    proc = pty.spawn(invocation.ptyFile, invocation.ptyArgs, {
      name: 'xterm-color',
      cols: 160,
      rows: 48,
      cwd: project.path,
      env: spawnEnv,
    })
  } catch (error) {
    const errorPayload = {
      ...buildUserFacingStartError(invocation.diagnostic, preset.startCommand),
      message: error instanceof Error ? error.message : 'PTY konnte nicht gestartet werden.',
      finalStartCommand: invocation.finalCommand,
      finalPtyCommand: invocation.ptyCommand,
    }
    updateSessionLifecycle(sessionId, project.id, 'failed', errorPayload)
    broadcastStartProgress('pty_spawn_failed', { sessionId, projectId: project.id, message: errorPayload.message })
    appendRuntimeLog('start_failed', { sessionId, projectId: project.id, reason: 'pty_spawn_failed' })
    emitAll()
    broadcast('error', errorPayload)
    return null
  }

  runtimeSessions.set(sessionId, {
    id: sessionId,
    projectId: project.id,
    pty: proc,
    shell: invocation.shell,
    cwd: project.path,
    command: invocation.finalCommand,
  })
  parsersBySession.set(sessionId, {
    agentParser: new AgentParser(),
    usageParser: new UsageParser(),
  })

  appendSessionEvent(sessionId, project.id, 'session_started', {
    cwd: project.path,
    shell: invocation.shell,
    command: invocation.finalCommand,
    mode,
    finalPtyCommand: invocation.ptyCommand,
  })
  updateSessionLifecycle(sessionId, project.id, 'running', {
    finalStartCommand: invocation.finalCommand,
    finalPtyCommand: invocation.ptyCommand,
  })
  appendRuntimeLog('pty_spawn_success', { sessionId, projectId: project.id })
  broadcastStartProgress('pty_spawn_success', { sessionId, projectId: project.id, message: 'Claude Code PTY laeuft.' })

  scheduleStatusPoll(sessionId)

  proc.onData((chunk) => handleOutput(sessionId, project.id, chunk))
  proc.onExit(({ exitCode, signal }) => {
    clearStatusPoll(sessionId)
    updateSessionLifecycle(sessionId, project.id, exitCode === 0 ? 'ended' : 'failed', { exitCode, signal })
    db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(
      exitCode === 0 ? 'paused' : 'error',
      now(),
      project.id,
    )
    appendSessionEvent(sessionId, project.id, 'session_stopped', { exitCode, signal })
    appendRuntimeLog('pty_exit', { sessionId, projectId: project.id, exitCode, signal })
    if (exitCode !== 0) {
      appendLog(
        sessionId,
        project.id,
        'error',
        `Claude-Session beendet mit Exit-Code ${exitCode}${signal ? ` (Signal: ${signal})` : ''}`,
      )
      broadcast('error', {
        message: `Claude-Session wurde unerwartet beendet (Exit-Code ${exitCode}).`,
      })
    }
    runtimeSessions.delete(sessionId)
    parsersBySession.delete(sessionId)
    emitAll()
  })

  emitAll()
  return sessionId
}

function createProject({ name, path: projectPath }) {
  const timestamp = now()
  const id = uuid()
  appendRuntimeLog('project_create_requested', { path: projectPath, name })
  db.prepare(
    `INSERT INTO projects (id, name, path, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, projectPath, 'paused', timestamp, timestamp)
  appendRuntimeLog('project_created', { projectId: id, path: projectPath, name })
  emitAll()
  return id
}

function handleOutput(sessionId, projectId, chunk) {
  const logId = appendLog(sessionId, projectId, 'output', chunk)
  db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now(), sessionId)
  broadcast('pty_output', { sessionId, projectId, chunk, createdAt: now() })
  appendRuntimeLog('pty_output_received', { sessionId, projectId, bytes: Buffer.byteLength(chunk) })
  consumeParsers(sessionId, projectId, chunk, logId)
  emitAll()
}

function stopSession(sessionId) {
  clearStatusPoll(sessionId)
  const session = runtimeSessions.get(sessionId)
  if (!session) {
    db.prepare('UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?').run('ended', now(), sessionId)
    emitAll()
    return
  }

  appendSessionEvent(sessionId, session.projectId, 'session_stopped', { manual: true })
  session.pty.kill()
}

function restartSession(sessionId) {
  const row = db
    .prepare(
      `SELECT id, project_id AS projectId, mode, preferred
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId)
  if (!row) {
    return null
  }

  stopSession(sessionId)
  const project = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(row.projectId)
  if (!project) {
    return null
  }

  return spawnSession(project, {
    mode: row.mode,
    forceNewSession: true,
    preferred: Boolean(row.preferred),
  })
}

function sendInput(sessionId, input, options = {}) {
  const session = runtimeSessions.get(sessionId)
  if (!session) {
    const row = db
      .prepare('SELECT id, project_id AS projectId, status FROM sessions WHERE id = ?')
      .get(sessionId)
    if (row && RUNTIME_ACTIVE_SESSION_STATUSES.includes(row.status)) {
      markSessionStale(row, 'send_input_without_runtime_pty')
      emitAll()
    }
    appendRuntimeLog('error', { reason: 'send_input_without_runtime_session', sessionId })
    broadcast('error', {
      message: 'Diese Session hat keinen laufenden PTY-Prozess mehr. Bitte starte Claude Code erneut.',
      sessionId,
    })
    return
  }

  if (!options.silent) {
    appendLog(sessionId, session.projectId, 'input', input)
  }
  appendSessionEvent(sessionId, session.projectId, 'command_sent', { input, silent: Boolean(options.silent) })
  session.pty.write(`${input}\r`)
  emitAll()
}

function sendTerminalInput(sessionId, data) {
  const session = runtimeSessions.get(sessionId)
  if (!session) {
    broadcast('error', { message: 'Session ist aktuell nicht verbunden.' })
    return
  }

  session.pty.write(data)
}

function resizeSession(sessionId, cols, rows) {
  const session = runtimeSessions.get(sessionId)
  if (!session) {
    return
  }

  session.pty.resize(Math.max(20, Number(cols) || 80), Math.max(10, Number(rows) || 24))
}

function updateSettings(payload) {
  for (const [key, value] of Object.entries(payload)) {
    upsertSetting.run({ key, value: JSON.stringify(value) })
  }
  for (const sessionId of runtimeSessions.keys()) {
    scheduleStatusPoll(sessionId)
  }
  emitAll()
}

function updateCommandPreset(payload) {
  persistModePreset(payload)
  emitAll()
}

function defaultDiagnosticCwd(payload = {}) {
  if (payload.projectId) {
    const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(payload.projectId)
    if (project?.path) {
      return project.path
    }
  }
  return payload.cwd || process.cwd()
}

function diagnosticForPayload(payload = {}) {
  const settings = readSettings()
  const mode = payload.mode || settings.defaultMode
  const preset = payload.preset || resolveModePreset(mode)
  const cwd = defaultDiagnosticCwd(payload)
  const env = buildSpawnEnvironment(preset)
  const shell = getShellPath(env)
  const diagnostic = buildStartDiagnostic(shell, preset.startCommand, cwd, env)
  const invocation = resolveStartInvocation(preset, cwd, env)

  return {
    ok: invocation.ok,
    kind: 'claudestart',
    mode,
    shell,
    home: env.HOME || os.homedir(),
    user: env.USER || os.userInfo().username,
    cwd,
    path: diagnostic.path,
    which: diagnostic.which,
    type: diagnostic.type,
    commandV: diagnostic.commandV,
    alias: diagnostic.alias,
    whence: diagnostic.whence,
    shellFiles: diagnostic.shellFiles,
    candidates: diagnostic.candidates,
    resolution: diagnostic.resolution,
    finalStartCommand: invocation.finalCommand,
    finalPtyCommand: invocation.ptyCommand || '',
    stdout: diagnostic.stdout,
    stderr: diagnostic.stderr,
    exitCode: diagnostic.exitCode,
    suggestion: invocation.ok
      ? 'Startbefehl wurde gefunden.'
      : invocation.suggestion,
  }
}

function diagnoseRuntime(payload = {}) {
  const cwd = defaultDiagnosticCwd(payload)
  const shell = getShellPath()
  const pathDiagnostic = runShellDiagnostic(shell, 'printf "%s" "$PATH"', cwd)
  return {
    ok: true,
    shell,
    home: process.env.HOME || os.homedir(),
    user: process.env.USER || os.userInfo().username,
    cwd,
    path: pathDiagnostic.stdout.trim() || process.env.PATH || '',
    shellFiles: buildStartDiagnostic(shell, 'claudestart', cwd).shellFiles,
    stdout: pathDiagnostic.stdout,
    stderr: pathDiagnostic.stderr,
    exitCode: pathDiagnostic.status,
    nativeRuntimeStatus,
    finalStartCommand: '',
    finalPtyCommand: '',
  }
}

function diagnoseNativeRuntime() {
  const nodeModulesPath = path.join(sidecarRoot, 'node_modules')
  const spawnHelperPath = path.join(nodeModulesPath, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  const exists = (targetPath) => fs.existsSync(targetPath)
  const executable = (targetPath) => {
    try {
      fs.accessSync(targetPath, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  return {
    ok: Boolean(pty),
    kind: 'native_runtime',
    nodeBinary: process.execPath,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    appDir: appDataDir,
    resourceDir: sidecarRoot,
    sidecarRoot,
    nodeModules: {
      path: nodeModulesPath,
      exists: exists(nodeModulesPath),
    },
    betterSqlite3: {
      available: storageMode === 'sqlite',
      storageMode,
      error: storageWarning,
      bootstrap: bootstrapDiagnostics?.modules?.['better-sqlite3'] || null,
    },
    nodePty: {
      available: Boolean(pty),
      bootstrap: bootstrapDiagnostics?.modules?.['node-pty'] || null,
    },
    ws: bootstrapDiagnostics?.modules?.ws || null,
    uuid: bootstrapDiagnostics?.modules?.uuid || null,
    spawnHelper: {
      path: spawnHelperPath,
      exists: exists(spawnHelperPath),
      executable: executable(spawnHelperPath),
    },
    diagnostics: bootstrapDiagnostics,
    nativeRuntimeStatus,
    suggestion: pty
      ? 'Native Runtime ist bereit.'
      : 'node-pty ist nicht verfuegbar. Fuehre npm run sidecar:prepare oder npm run sidecar:rebuild-native aus und pruefe diagnostics.json.',
  }
}

function exportDiagnostics() {
  return {
    ok: true,
    exportedAt: now(),
    dbPath: storageMode === 'sqlite' ? dbPath : jsonFallbackPath,
    storageMode,
    storageWarning,
    migrationStatus,
    nativeRuntimeStatus,
    hookStatus: hookStatus(),
    runtimeSessions: Array.from(runtimeSessions.values()).map((session) => ({
      id: session.id,
      projectId: session.projectId,
      shell: session.shell,
      cwd: session.cwd,
      command: session.command,
    })),
    recentRuntimeEvents: runtimeEvents.slice(0, 80),
  }
}

function repairDatabase() {
  try {
    createBaseTables(db)
    migrationStatus = migrateAll(db, { defaultPresets: DEFAULT_MODE_PRESETS })
    migrationStatus.schemaValidation = validateSchema(db)
    seedDefaultSettingsAndPresets()
    nativeRuntimeStatus.sqlite.migrationStatus = migrationStatus
    const result = {
      ok: true,
      message: 'Datenbank wurde repariert und Migrationen wurden erneut angewendet.',
      storageMode,
      dbPath: storageMode === 'sqlite' ? dbPath : jsonFallbackPath,
      commandPresetColumns: getTableColumns(db, 'command_presets'),
      migrationStatus,
    }
    appendRuntimeLog('database_repaired', result)
    emitAll()
    return result
  } catch (error) {
    const result = {
      ok: false,
      message: 'Datenbank-Reparatur ist fehlgeschlagen.',
      storageMode,
      dbPath: storageMode === 'sqlite' ? dbPath : jsonFallbackPath,
      error: migrationErrorDetails(error),
      commandPresetColumns: safeTableColumns('command_presets'),
    }
    appendRuntimeLog('database_repair_failed', result)
    return result
  }
}

function resetDatabaseWithBackup() {
  const backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
  try {
    if (storageMode === 'sqlite' && fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupPath)
    }
    for (const table of [
      'projects',
      'sessions',
      'messages',
      'raw_logs',
      'agents',
      'agent_events',
      'usage_snapshots',
      'settings',
      'command_presets',
      'schema_migrations',
      'session_events',
      'session_runtime_events',
      'raw_hook_events',
      'hook_events',
      'tool_calls',
      'subagents',
      'subagent_events',
      'session_status',
      'token_usage',
      'file_changes',
      'permission_requests',
      'notifications',
    ]) {
      try {
        db.exec(`DELETE FROM "${table}";`)
      } catch {
        // table may not exist in older DBs
      }
    }
    createBaseTables(db)
    migrationStatus = migrateAll(db, { defaultPresets: DEFAULT_MODE_PRESETS })
    migrationStatus.schemaValidation = validateSchema(db)
    seedDefaultSettingsAndPresets()
    nativeRuntimeStatus.sqlite.migrationStatus = migrationStatus
    const result = {
      ok: true,
      message: 'Datenbank wurde gesichert und auf Default-Schema zurueckgesetzt.',
      backupPath: storageMode === 'sqlite' ? backupPath : null,
      storageMode,
      commandPresetColumns: getTableColumns(db, 'command_presets'),
      migrationStatus,
    }
    appendRuntimeLog('database_reset_with_backup', result)
    emitAll()
    return result
  } catch (error) {
    const result = {
      ok: false,
      message: 'Datenbank-Reset ist fehlgeschlagen.',
      backupPath: storageMode === 'sqlite' ? backupPath : null,
      error: migrationErrorDetails(error),
      commandPresetColumns: safeTableColumns('command_presets'),
    }
    appendRuntimeLog('database_reset_failed', result)
    return result
  }
}

function safeTableColumns(tableName) {
  try {
    return getTableColumns(db, tableName)
  } catch {
    return []
  }
}

function testShellCommand(payload = {}) {
  const cwd = defaultDiagnosticCwd(payload)
  const shell = getShellPath()
  const command = payload.command || 'type claudestart'
  const result = runShellDiagnostic(shell, command, cwd)
  return {
    ok: result.ok,
    shell,
    cwd,
    command,
    finalStartCommand: command,
    finalPtyCommand: `${shell} ${result.args.join(' ')}`,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  }
}

function testPtyStart(payload = {}) {
  const diagnosis = diagnosticForPayload(payload)
  if (!diagnosis.ok) {
    return Promise.resolve(diagnosis)
  }
  if (!pty) {
    return Promise.resolve({
      ...diagnosis,
      ok: false,
      message: 'node-pty ist nicht verfuegbar.',
      stderr: bootstrapDiagnostics?.modules?.['node-pty']?.error?.stack || '',
      nativeRuntimeStatus,
      suggestion: 'Pruefe .sidecar-bundle/diagnostics.json und fuehre ggf. npm run sidecar:rebuild-native aus.',
    })
  }

  const settings = readSettings()
  const mode = payload.mode || settings.defaultMode
  const preset = payload.preset || resolveModePreset(mode)
  const env = buildSpawnEnvironment(preset)
  const shell = getShellPath(env)
  const probe = [
    'printf "PTY probe ok\\n"',
    'printf "PWD=$PWD\\n"',
    'printf "PATH=$PATH\\n"',
    `type ${shellQuote(preset.startCommand)} 2>&1`,
  ].join('; ')
  const args = shellArgsForInteractiveLoginCommand(shell, probe)

  return new Promise((resolve) => {
    let stdout = ''
    let resolved = false
    const proc = pty.spawn(shell, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 24,
      cwd: diagnosis.cwd,
      env,
    })

    const finish = (payloadResult) => {
      if (resolved) {
        return
      }
      resolved = true
      resolve({
        ...diagnosis,
        ...payloadResult,
        stdout,
        finalPtyCommand: `${shell} ${args.join(' ')}`,
      })
    }

    proc.onData((chunk) => {
      stdout += chunk
    })
    proc.onExit(({ exitCode, signal }) => {
      finish({ ok: exitCode === 0, exitCode, signal, stderr: '' })
    })
    setTimeout(() => {
      proc.kill()
      finish({ ok: false, exitCode: -1, stderr: 'PTY probe timed out.' })
    }, 5000)
  })
}

function createProjectAndStart(payload) {
  const name = payload.name || payload.path?.split('/').filter(Boolean).at(-1) || 'Project'
  const existing = db.prepare('SELECT id, name, path FROM projects WHERE path = ?').get(payload.path)
  const projectId = existing?.id || createProject({ name, path: payload.path })
  const project = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(projectId)
  if (!project) {
    broadcast('error', { message: 'Projekt konnte nicht erstellt werden.' })
    return null
  }
  return spawnSession(project, { mode: payload.mode, forceNewSession: Boolean(payload.forceNewSession) })
}

function hookCommand(projectPath) {
  return `"${projectPath}/.claude/hooks/claude-mac-hook.sh"`
}

function hookRelayScript(projectPath) {
  const hookUrl = hookStatus().url
  const forwarderPath = path.join(projectPath, '.claude', 'hooks', 'claude-mac-hook-forwarder.js')
  return `#!/bin/zsh
set -u

HOOK_URL="\${CLAUDE_MAC_HOOK_URL:-${hookUrl}}"
FORWARDER=${shellQuote(forwarderPath)}

if command -v node >/dev/null 2>&1 && [ -f "$FORWARDER" ]; then
  node "$FORWARDER" "$HOOK_URL" >/dev/null 2>&1 || true
elif command -v curl >/dev/null 2>&1; then
  curl -sS -m 1.5 -X POST \\
    -H "Content-Type: application/json" \\
    -H "X-Claude-Mac-App: 1" \\
    --data-binary @- "$HOOK_URL" >/dev/null 2>&1 || true
fi

printf '{"continue":true}\\n'
exit 0
`
}

function hookMatcherEntry(projectPath) {
  return {
    matcher: TOOL_MATCHER,
    hooks: [
      {
        type: 'command',
        command: hookCommand(projectPath),
        timeout: 2,
      },
    ],
  }
}

function hookEventEntry(projectPath) {
  return {
    hooks: [
      {
        type: 'command',
        command: hookCommand(projectPath),
        timeout: 2,
      },
    ],
  }
}

function buildHookSettingsFragment(projectPath) {
  return {
    hooks: {
      SessionStart: [hookEventEntry(projectPath)],
      PreToolUse: [hookMatcherEntry(projectPath)],
      PostToolUse: [hookMatcherEntry(projectPath)],
      PostToolUseFailure: [hookMatcherEntry(projectPath)],
      PermissionRequest: [hookMatcherEntry(projectPath)],
      Notification: [hookEventEntry(projectPath)],
      UserPromptSubmit: [hookEventEntry(projectPath)],
      Stop: [hookEventEntry(projectPath)],
      SubagentStop: [hookEventEntry(projectPath)],
      PreCompact: [hookEventEntry(projectPath)],
    },
  }
}

function sameHookHandler(left, right) {
  return left?.type === right?.type && left?.command === right?.command && left?.url === right?.url
}

function mergeHookEntries(existingEntries = [], nextEntries = []) {
  const merged = Array.isArray(existingEntries) ? [...existingEntries] : []
  for (const nextEntry of nextEntries) {
    const matcher = nextEntry.matcher || ''
    const existing = merged.find((entry) => (entry.matcher || '') === matcher)
    if (!existing) {
      merged.push(nextEntry)
      continue
    }

    const hooks = Array.isArray(existing.hooks) ? existing.hooks : []
    for (const nextHook of nextEntry.hooks || []) {
      if (!hooks.some((hook) => sameHookHandler(hook, nextHook))) {
        hooks.push(nextHook)
      }
    }
    existing.hooks = hooks
  }
  return merged
}

function mergeHookSettings(existingSettings, projectPath) {
  const fragment = buildHookSettingsFragment(projectPath)
  const merged = {
    ...existingSettings,
    hooks: {
      ...(existingSettings.hooks || {}),
    },
  }

  for (const [eventName, entries] of Object.entries(fragment.hooks)) {
    merged.hooks[eventName] = mergeHookEntries(merged.hooks[eventName], entries)
  }

  return merged
}

function hookInstallPreview(projectId) {
  const project = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(projectId)
  if (!project) {
    throw new Error('Projekt nicht gefunden.')
  }
  if (!hookPort) {
    throw new Error('Hook Receiver ist noch nicht bereit. Bitte in wenigen Sekunden erneut versuchen.')
  }
  const claudeDir = path.join(project.path, '.claude')
  const hooksDir = path.join(claudeDir, 'hooks')
  const settingsPath = path.join(claudeDir, 'settings.local.json')
  const scriptPath = path.join(hooksDir, 'claude-mac-hook.sh')
  const forwarderPath = path.join(hooksDir, 'claude-mac-hook-forwarder.js')
  return {
    projectId: project.id,
    projectPath: project.path,
    hookUrl: hookStatus().url,
    settingsPath,
    scriptPath,
    forwarderPath,
    settingsFragment: buildHookSettingsFragment(project.path),
  }
}

function installProjectHooks(projectId) {
  const project = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(projectId)
  if (!project) {
    throw new Error('Projekt nicht gefunden.')
  }
  if (!hookPort) {
    throw new Error('Hook Receiver ist noch nicht bereit. Bitte in wenigen Sekunden erneut versuchen.')
  }

  const claudeDir = path.join(project.path, '.claude')
  const hooksDir = path.join(claudeDir, 'hooks')
  const settingsPath = path.join(claudeDir, 'settings.local.json')
  const scriptPath = path.join(hooksDir, 'claude-mac-hook.sh')
  const forwarderPath = path.join(hooksDir, 'claude-mac-hook-forwarder.js')
  fs.mkdirSync(hooksDir, { recursive: true })

  let existingSettings = {}
  let backupPath = null
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    backupPath = `${settingsPath}.bak.${Date.now()}`
    fs.copyFileSync(settingsPath, backupPath)
    try {
      existingSettings = JSON.parse(raw || '{}')
    } catch {
      existingSettings = {}
    }
  }

  fs.copyFileSync(path.join(sidecarRoot, 'hook-forwarder.js'), forwarderPath)
  fs.chmodSync(forwarderPath, 0o755)
  fs.writeFileSync(scriptPath, hookRelayScript(project.path), { mode: 0o755 })
  fs.chmodSync(scriptPath, 0o755)
  const merged = mergeHookSettings(existingSettings, project.path)
  fs.writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`)

  const result = {
    ok: true,
    projectId: project.id,
    projectPath: project.path,
    settingsPath,
    scriptPath,
    forwarderPath,
    backupPath,
    hookUrl: hookStatus().url,
  }
  appendRuntimeLog('hooks_installed', result)
  broadcast('hooks_install_result', result)
  emitAll()
  return result
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setTimeout(2000, () => {
      reject(new Error('Hook request timed out.'))
      request.destroy()
    })
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 2_000_000) {
        reject(new Error('Hook payload too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function createHookServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
      if (request.method === 'GET' && url.pathname === '/hooks/status') {
        writeJson(response, 200, hookStatus())
        return
      }
      if (request.method === 'GET' && url.pathname === '/hooks/install-preview') {
        const projectId = url.searchParams.get('projectId')
        if (!projectId) {
          writeJson(response, 200, {
            hookUrl: hookStatus().url,
            supportedEvents: HOOK_EVENTS,
            toolMatcher: TOOL_MATCHER,
          })
          return
        }
        writeJson(response, 200, hookInstallPreview(projectId))
        return
      }
      if (request.method === 'POST' && url.pathname === '/hooks/claude') {
        try {
          const payload = await readRequestJson(request)
          handleClaudeHookEvent(payload)
          writeJson(response, 200, { continue: true })
        } catch (error) {
          appendRuntimeLog('hook_event_failed', {
            message: error instanceof Error ? error.message : 'Hook konnte nicht verarbeitet werden.',
          })
          writeJson(response, 200, { continue: true })
        }
        return
      }
      if (request.method === 'POST' && url.pathname === '/hooks/test') {
        try {
          const payload = await readRequestJson(request)
          const result = handleClaudeHookEvent({
            hook_event_name: payload.hook_event_name || 'Notification',
            message: payload.message || 'Claude Mac hook receiver test event',
            cwd: payload.cwd || process.cwd(),
            session_id: payload.session_id || `hook-test-${Date.now()}`,
            ...payload,
          })
          writeJson(response, 200, { ok: true, continue: true, result })
        } catch (error) {
          appendRuntimeLog('hook_event_failed', {
            message: error instanceof Error ? error.message : 'Hook-Test konnte nicht verarbeitet werden.',
          })
          writeJson(response, 200, { ok: false, continue: true })
        }
        return
      }
      writeJson(response, 404, { ok: false, message: 'Not found' })
    } catch (error) {
      writeJson(response, 200, {
        continue: true,
        error: error instanceof Error ? error.message : 'Hook safe-failed.',
      })
    }
  })
}

function listenHookServer(portToUse) {
  return new Promise((resolve, reject) => {
    hookServer.once('error', reject)
    hookServer.listen(portToUse, '127.0.0.1', () => {
      hookServer.off('error', reject)
      const address = hookServer.address()
      hookPort = typeof address === 'object' && address ? address.port : null
      resolve(hookPort)
    })
  })
}

async function startHookReceiver() {
  hookServer = createHookServer()

  try {
    await listenHookServer(DEFAULT_HOOK_PORT)
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      hookServer = createHookServer()
      await listenHookServer(0)
    } else {
      appendRuntimeLog('hook_receiver_failed', {
        message: error instanceof Error ? error.message : 'Hook receiver failed.',
      })
      throw error
    }
  }

  hookServer.on('error', (error) => {
    appendRuntimeLog('hook_receiver_failed', {
      message: error instanceof Error ? error.message : 'Hook receiver failed.',
    })
  })

  appendRuntimeLog('hook_receiver_started', hookStatus())
  broadcast('hook_status_updated', hookStatus())
  return hookPort
}

function recoverSessions() {
  const settings = readSettings()
  const activeRows = db
    .prepare(
      `SELECT id, project_id AS projectId, mode, preferred, status
       FROM sessions
       WHERE status IN (${RUNTIME_ACTIVE_STATUS_SQL})
       ORDER BY started_at DESC`,
    )
    .all(...RUNTIME_ACTIVE_SESSION_STATUSES)

  if (!activeRows.length) {
    return
  }

  if (settings.sessionRecovery) {
    for (const row of activeRows) {
      if (runtimeSessions.has(row.id)) {
        continue
      }

      if (row.status !== 'active') {
        markSessionStale(row, 'sidecar_boot_without_runtime_pty')
        continue
      }

      const project = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(row.projectId)
      if (project) {
        spawnSession(project, {
          mode: row.mode,
          forceNewSession: true,
          preferred: Boolean(row.preferred),
        })
      }
      db.prepare('UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?').run('ended', now(), row.id)
    }
  } else {
    for (const row of activeRows) {
      markSessionStale(row, 'session_recovery_disabled')
    }
  }
  emitAll()
}

wss.on('connection', (socket) => {
  appendRuntimeLog('websocket_connected', {})
  emitAll()
  socket.send(JSON.stringify({ type: 'connection_state', payload: { status: 'connected' } }))

  socket.on('message', async (buffer) => {
    const { type, payload } = JSON.parse(buffer.toString())

    try {
      if (!['terminal_input', 'resize_session', 'bootstrap'].includes(type)) {
        appendRuntimeLog('action_received', { type })
      }
      if (type === 'bootstrap') {
        socket.send(JSON.stringify({ type: 'bootstrap', payload: snapshot() }))
        return
      }
      if (type === 'create_project') {
        createProject(payload)
        return
      }
      if (type === 'create_project_and_start') {
        const nextSessionId = createProjectAndStart(payload)
        if (nextSessionId) {
          const row = db.prepare('SELECT project_id AS projectId FROM sessions WHERE id = ?').get(nextSessionId)
          broadcast('session_selected', { sessionId: nextSessionId, projectId: row?.projectId || null })
        }
        return
      }
      if (type === 'diagnose_runtime') {
        const result = diagnoseRuntime(payload)
        broadcast('diagnostic_result', { kind: 'runtime', result })
        return
      }
      if (type === 'diagnose_native_runtime') {
        const result = diagnoseNativeRuntime()
        broadcast('diagnostic_result', { kind: 'native_runtime', result })
        return
      }
      if (type === 'export_diagnostics') {
        const result = exportDiagnostics()
        broadcast('diagnostic_result', { kind: 'export_diagnostics', result })
        return
      }
      if (type === 'repair_database') {
        const result = repairDatabase()
        broadcast('diagnostic_result', { kind: 'database_repair', result })
        if (!result.ok) {
          broadcast('error', result)
        }
        return
      }
      if (type === 'reset_database_with_backup') {
        const result = resetDatabaseWithBackup()
        broadcast('diagnostic_result', { kind: 'database_reset', result })
        if (!result.ok) {
          broadcast('error', result)
        }
        return
      }
      if (type === 'diagnose_claudestart') {
        appendRuntimeLog('shell_diagnostic_started', { command: 'diagnose_claudestart' })
        const result = diagnosticForPayload(payload)
        appendRuntimeLog('shell_diagnostic_finished', { ok: result.ok, resolution: result.resolution })
        broadcast('diagnostic_result', { kind: 'claudestart', result })
        return
      }
      if (type === 'test_shell_command') {
        const result = testShellCommand(payload)
        broadcast('diagnostic_result', { kind: 'shell_command', result })
        return
      }
      if (type === 'test_pty_start') {
        const result = await testPtyStart(payload)
        broadcast('diagnostic_result', { kind: 'pty_start', result })
        return
      }
      if (type === 'hooks_status') {
        broadcast('hook_status_updated', hookStatus())
        return
      }
      if (type === 'hooks_install_preview') {
        const result = hookInstallPreview(payload.projectId)
        broadcast('hooks_install_preview', result)
        return
      }
      if (type === 'install_project_hooks') {
        installProjectHooks(payload.projectId)
        return
      }
      if (type === 'start_session') {
        const project = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(payload.projectId)
        if (!project) {
          broadcast('error', { message: 'Projekt nicht gefunden.' })
          return
        }
        const nextSessionId = spawnSession(project, {
          mode: payload.mode,
          forceNewSession: Boolean(payload.forceNewSession),
        })
        if (nextSessionId) {
          broadcast('session_selected', { sessionId: nextSessionId, projectId: project.id })
        }
        return
      }
      if (type === 'start_session_verbose' || type === 'start_claude_session_verbose') {
        broadcastStartProgress('request_received', {
          projectId: payload.projectId,
          mode: payload.mode,
          command: type,
        })
        const project = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(payload.projectId)
        if (!project) {
          broadcastStartProgress('failed', { projectId: payload.projectId, message: 'Projekt nicht gefunden.' })
          broadcast('error', { message: 'Projekt nicht gefunden.' })
          return
        }
        broadcastStartProgress('project_checked', { projectId: project.id, cwd: project.path })
        const result = diagnosticForPayload(payload)
        broadcast('diagnostic_result', { kind: 'claudestart', result })
        const nextSessionId = spawnSession(project, {
          mode: payload.mode,
          forceNewSession: Boolean(payload.forceNewSession),
        })
        if (nextSessionId) {
          broadcast('session_selected', { sessionId: nextSessionId, projectId: project.id })
        }
        return
      }
      if (type === 'stop_session') {
        stopSession(payload.sessionId)
        return
      }
      if (type === 'restart_session') {
        const nextSessionId = restartSession(payload.sessionId)
        if (nextSessionId) {
          const row = db.prepare('SELECT project_id AS projectId FROM sessions WHERE id = ?').get(nextSessionId)
          broadcast('session_selected', { sessionId: nextSessionId, projectId: row?.projectId || null })
        }
        return
      }
      if (type === 'send_input') {
        sendInput(payload.sessionId, payload.input)
        return
      }
      if (type === 'terminal_input') {
        sendTerminalInput(payload.sessionId, payload.data)
        return
      }
      if (type === 'resize_session') {
        resizeSession(payload.sessionId, payload.cols, payload.rows)
        return
      }
      if (type === 'update_settings') {
        updateSettings(payload)
        return
      }
      if (type === 'update_command_preset') {
        updateCommandPreset(payload)
        return
      }
    } catch (error) {
      appendRuntimeLog('error', {
        type,
        message: error instanceof Error ? error.message : 'Sidecar-Fehler',
      })
      broadcast('error', {
        message: error instanceof Error ? error.message : 'Sidecar-Fehler',
      })
    }
  })
})

const address = wss.address()
const port = typeof address === 'object' && address ? address.port : null
appendRuntimeLog('sidecar_start_requested', {
  port,
  dbPath,
  storageMode,
  storageWarning,
  appDataDir,
  pid: process.pid,
  nodeVersion: process.version,
  arch: process.arch,
  platform: process.platform,
  nativeRuntimeStatus,
})
if (storageWarning) {
  appendRuntimeLog('storage_fallback_active', { storageMode, storageWarning, dbPath: jsonFallbackPath })
}
await startHookReceiver()
writeDaemonManifest(port)
appendRuntimeLog('sidecar_ready', { port, hookPort, dbPath, storageMode, appDataDir, pid: process.pid, nativeRuntimeStatus })
recoverSessions()
process.stdout.write(`${JSON.stringify({ type: 'ready', port, hookPort, dbPath, storageMode, appDataDir, pid: process.pid, nativeRuntimeStatus })}\n`)

process.on('exit', () => {
  try {
    fs.rmSync(daemonManifestPath, { force: true })
  } catch {
    // ignore
  }
})
