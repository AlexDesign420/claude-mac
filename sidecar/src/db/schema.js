export const COMMAND_PRESET_COLUMNS = [
  'id',
  'mode',
  'label',
  'start_command',
  'start_args',
  'env_json',
  'description',
  'enabled',
  'updated_at',
]

export const REQUIRED_TABLE_COLUMNS = {
  projects: ['id', 'name', 'path', 'status', 'created_at', 'updated_at'],
  sessions: [
    'id',
    'project_id',
    'label',
    'status',
    'mode',
    'started_at',
    'last_activity_at',
    'shell',
    'cwd',
    'command',
    'recovery_key',
    'preferred',
  ],
  settings: ['key', 'value'],
  command_presets: COMMAND_PRESET_COLUMNS,
  schema_migrations: ['id', 'version', 'name', 'applied_at'],
  raw_logs: ['id', 'session_id', 'project_id', 'direction', 'chunk', 'created_at'],
  session_events: ['id', 'session_id', 'project_id', 'event_type', 'payload', 'created_at'],
  raw_hook_events: ['id', 'session_id', 'project_id', 'hook_event_name', 'tool_name', 'raw_json'],
  hook_events: ['id', 'session_id', 'project_id', 'hook_event_name', 'tool_name', 'raw_json'],
  tool_calls: ['id', 'session_id', 'project_id', 'tool_name', 'status', 'started_at'],
  agents: ['id', 'name', 'session_id', 'project_id', 'status', 'started_at', 'last_activity_at'],
  subagents: ['id', 'session_id', 'project_id', 'name', 'status', 'started_at', 'last_activity_at'],
}

export class SchemaValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'SchemaValidationError'
    this.details = details
  }
}

export function validateSchema(db, required = REQUIRED_TABLE_COLUMNS) {
  const failures = []

  for (const [tableName, expectedColumns] of Object.entries(required)) {
    const existingColumns = getTableColumns(db, tableName)
    if (existingColumns.length === 0) {
      failures.push({
        tableName,
        existingColumns,
        expectedColumns,
        missingColumns: expectedColumns,
      })
      continue
    }

    const missingColumns = expectedColumns.filter((column) => !existingColumns.includes(column))
    if (missingColumns.length > 0) {
      failures.push({
        tableName,
        existingColumns,
        expectedColumns,
        missingColumns,
      })
    }
  }

  if (failures.length > 0) {
    throw new SchemaValidationError('SQLite-Schema ist unvollstaendig oder veraltet.', {
      failures,
    })
  }

  return {
    ok: true,
    checkedTables: Object.keys(required),
  }
}

function getTableColumns(db, tableName) {
  try {
    return db.prepare(`PRAGMA table_info("${String(tableName).replaceAll('"', '""')}")`).all().map((column) => column.name)
  } catch {
    return []
  }
}
