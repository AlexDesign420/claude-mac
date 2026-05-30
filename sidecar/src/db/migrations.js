import crypto from 'node:crypto'

import { COMMAND_PRESET_COLUMNS } from './schema.js'

export class MigrationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'MigrationError'
    this.details = details
  }
}

export function getTableColumns(db, tableName) {
  try {
    return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((column) => column.name)
  } catch (error) {
    throw new MigrationError(`Spalten fuer Tabelle "${tableName}" konnten nicht gelesen werden.`, {
      tableName,
      error: errorPayload(error),
    })
  }
}

export function tableExists(db, tableName) {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName)
    return Boolean(row?.name)
  } catch {
    return getTableColumns(db, tableName).length > 0
  }
}

export function migrateAll(db, options = {}) {
  const defaultPresets = options.defaultPresets || []
  const applied = []
  ensureSchemaMigrations(db)
  applyMigration(db, 1, 'initial', () => {}, applied)
  applyMigration(
    db,
    2,
    'command_presets_mode_migration',
    () => migrateCommandPresets(db, { defaultPresets }),
    applied,
  )
  applyMigration(db, 3, 'hooks_tables', () => ensureHookColumns(db), applied)
  applyMigration(db, 4, 'agent_tables', () => ensureAgentColumns(db), applied)
  migrateCommandPresets(db, { defaultPresets })
  ensureHookColumns(db)
  ensureAgentColumns(db)
  return {
    ok: true,
    applied,
    commandPresetColumns: getTableColumns(db, 'command_presets'),
  }
}

export function migrateCommandPresets(db, options = {}) {
  const defaultPresets = options.defaultPresets || []
  const exists = tableExists(db, 'command_presets')
  if (!exists) {
    createCommandPresetsTable(db)
    insertDefaultPresets(db, defaultPresets)
    return { recreated: true, reason: 'missing_table' }
  }

  const columns = getTableColumns(db, 'command_presets')
  const missing = COMMAND_PRESET_COLUMNS.filter((column) => !columns.includes(column))
  if (missing.length > 0) {
    const legacyRows = readLegacyCommandPresets(db)
    const legacyStartCommand = extractLegacyStartCommand(legacyRows)
    const legacyName = `command_presets_legacy_${timestampForIdentifier()}`
    try {
      db.exec(`ALTER TABLE command_presets RENAME TO ${quoteIdentifier(legacyName)};`)
      createCommandPresetsTable(db)
      insertDefaultPresets(db, defaultPresets, legacyStartCommand)
      return {
        recreated: true,
        reason: 'missing_columns',
        legacyName,
        existingColumns: columns,
        missingColumns: missing,
        legacyStartCommand,
      }
    } catch (error) {
      throw new MigrationError('Migration von command_presets ist fehlgeschlagen.', {
        tableName: 'command_presets',
        legacyName,
        existingColumns: columns,
        expectedColumns: COMMAND_PRESET_COLUMNS,
        missingColumns: missing,
        error: errorPayload(error),
      })
    }
  }

  insertDefaultPresets(db, defaultPresets)
  return { recreated: false, reason: 'up_to_date' }
}

export function ensureSchemaMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)
}

function applyMigration(db, version, name, migrate, applied) {
  const existing = db.prepare('SELECT id FROM schema_migrations WHERE version = ?').get(version)
  if (existing) {
    return
  }
  try {
    const result = migrate()
    db.prepare(`INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)`).run(
      crypto.randomUUID(),
      version,
      name,
      new Date().toISOString(),
    )
    applied.push({ version, name, result })
  } catch (error) {
    if (error instanceof MigrationError) {
      throw error
    }
    throw new MigrationError(`Migration "${name}" ist fehlgeschlagen.`, {
      migration: name,
      version,
      error: errorPayload(error),
    })
  }
}

function createCommandPresetsTable(db) {
  db.exec(`
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
  `)
}

function insertDefaultPresets(db, defaultPresets, legacyStartCommand = null) {
  const now = new Date().toISOString()
  for (const preset of defaultPresets) {
    const existing = db.prepare('SELECT id FROM command_presets WHERE mode = ?').get(preset.mode)
    if (existing) {
      continue
    }
    db.prepare(
      `INSERT INTO command_presets (id, mode, label, start_command, start_args, env_json, description, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      preset.mode,
      preset.label,
      preset.mode === 'safe' && legacyStartCommand ? legacyStartCommand : preset.startCommand || 'claudestart',
      JSON.stringify(preset.startArgs || []),
      JSON.stringify(preset.env || {}),
      preset.description || '',
      Number(preset.enabled !== false),
      now,
    )
  }
}

function ensureHookColumns(db) {
  ensureColumns(db, 'raw_hook_events', {
    agent_type: 'TEXT',
    transcript_path: 'TEXT',
    agent_transcript_path: 'TEXT',
    cwd: 'TEXT',
    permission_mode: 'TEXT',
    created_at: 'TEXT',
  })
  ensureColumns(db, 'hook_events', {
    agent_type: 'TEXT',
    transcript_path: 'TEXT',
    agent_transcript_path: 'TEXT',
    cwd: 'TEXT',
    permission_mode: 'TEXT',
    created_at: 'TEXT',
  })
}

function ensureAgentColumns(db) {
  ensureColumns(db, 'sessions', {
    shell: 'TEXT',
    cwd: 'TEXT',
    command: 'TEXT',
    recovery_key: 'TEXT',
    preferred: 'INTEGER NOT NULL DEFAULT 1',
  })
  ensureColumns(db, 'usage_snapshots', {
    model: 'TEXT',
    provider: 'TEXT',
    context_window: 'INTEGER',
    source_log_id: 'TEXT',
  })
  ensureColumns(db, 'agents', {
    source_log_id: 'TEXT',
    agent_type: 'TEXT',
    current_tool: 'TEXT',
    transcript_path: 'TEXT',
    last_assistant_message: 'TEXT',
  })
  ensureColumns(db, 'subagents', {
    agent_type: 'TEXT',
    transcript_path: 'TEXT',
    agent_transcript_path: 'TEXT',
    last_assistant_message: 'TEXT',
  })
}

function ensureColumns(db, tableName, columns) {
  if (!tableExists(db, tableName)) {
    return
  }
  const existing = new Set(getTableColumns(db, tableName))
  for (const [columnName, definition] of Object.entries(columns)) {
    if (!existing.has(columnName)) {
      db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${definition};`)
    }
  }
}

function readLegacyCommandPresets(db) {
  try {
    return db.prepare('SELECT * FROM command_presets').all()
  } catch {
    return []
  }
}

function extractLegacyStartCommand(rows) {
  for (const row of rows) {
    const command = row.start_command || row.startCommand || row.command || row.start || row.value
    if (typeof command === 'string' && command.trim()) {
      return command.trim()
    }
  }
  return null
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function timestampForIdentifier() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '')
}

function errorPayload(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : '',
    name: error instanceof Error ? error.name : 'Error',
  }
}
