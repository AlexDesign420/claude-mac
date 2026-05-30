import fs from 'node:fs'
import path from 'node:path'

const TABLES = [
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
]

const SCHEMA = {
  sessions: ['id', 'project_id', 'label', 'status', 'mode', 'started_at', 'last_activity_at', 'shell', 'cwd', 'command', 'recovery_key', 'preferred'],
  usage_snapshots: ['id', 'session_id', 'project_id', 'total_tokens', 'tokens_per_minute', 'estimated', 'captured_at', 'model', 'provider', 'context_window', 'source_log_id'],
  agents: ['id', 'name', 'session_id', 'project_id', 'agent_type', 'status', 'started_at', 'last_activity_at', 'current_task', 'current_tool', 'transcript_path', 'last_assistant_message', 'token_estimate', 'source_log_id'],
  raw_hook_events: ['id', 'session_id', 'project_id', 'hook_event_name', 'tool_name', 'agent_id', 'parent_agent_id', 'agent_type', 'transcript_path', 'agent_transcript_path', 'cwd', 'permission_mode', 'timestamp', 'created_at', 'raw_json'],
  hook_events: ['id', 'session_id', 'project_id', 'hook_event_name', 'tool_name', 'agent_id', 'parent_agent_id', 'agent_type', 'transcript_path', 'agent_transcript_path', 'cwd', 'permission_mode', 'timestamp', 'created_at', 'raw_json'],
  command_presets: ['id', 'mode', 'label', 'start_command', 'start_args', 'env_json', 'description', 'enabled', 'updated_at'],
  schema_migrations: ['id', 'version', 'name', 'applied_at'],
  subagents: ['id', 'session_id', 'project_id', 'parent_agent_id', 'agent_type', 'name', 'status', 'task_prompt', 'transcript_path', 'agent_transcript_path', 'last_assistant_message', 'started_at', 'last_activity_at', 'completed_at', 'token_estimate', 'error', 'raw_event_id'],
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, char) => char.toUpperCase())
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim()
}

function firstArg(args) {
  return args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : null
}

function rowWithAliases(row) {
  if (!row) {
    return row
  }
  const mapped = { ...row }
  for (const [key, value] of Object.entries(row)) {
    mapped[snakeToCamel(key)] = value
  }
  return mapped
}

export class JsonFileDatabase {
  constructor(filePath) {
    this.filePath = filePath
    this.data = Object.fromEntries(TABLES.map((table) => [table, []]))
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
        for (const table of TABLES) {
          this.data[table] = Array.isArray(parsed[table]) ? parsed[table] : []
        }
      }
    } catch {
      this.data = Object.fromEntries(TABLES.map((table) => [table, []]))
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`)
  }

  pragma() {}

  exec(sql) {
    const normalized = normalizeSql(sql)
    const alterMatch = normalized.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i)
    if (alterMatch) {
      const [, table, column] = alterMatch
      SCHEMA[table] = Array.from(new Set([...(SCHEMA[table] || []), column]))
    }
    const renameMatch = normalized.match(/^ALTER TABLE (\w+) RENAME TO "?([\w_]+)"?/i)
    if (renameMatch) {
      const [, from, to] = renameMatch
      this.data[to] = this.data[from] || []
      this.data[from] = []
      SCHEMA[to] = SCHEMA[from] || []
    }
  }

  prepare(sql) {
    return new JsonStatement(this, sql)
  }
}

class JsonStatement {
  constructor(db, sql) {
    this.db = db
    this.sql = normalizeSql(sql)
  }

  all(...args) {
    return this.query(args).map(rowWithAliases)
  }

  get(...args) {
    return rowWithAliases(this.query(args)[0])
  }

  run(...args) {
    this.execute(args)
    this.db.save()
    return { changes: 1 }
  }

  query(args) {
    const sql = this.sql
    const pragma = sql.match(/^PRAGMA table_info\("?(\w+)"?\)/i)
    if (pragma) {
      const table = pragma[1]
      return (SCHEMA[table] || []).map((name, cid) => ({ cid, name }))
    }
    if (/SELECT key, value FROM settings/i.test(sql)) {
      return clone(this.db.data.settings)
    }
    if (/SELECT key FROM settings WHERE key = \?/i.test(sql)) {
      return this.db.data.settings.filter((row) => row.key === args[0])
    }
    if (/FROM sqlite_master WHERE type = 'table' AND name = \?/i.test(sql)) {
      return this.db.data[args[0]] ? [{ name: args[0] }] : []
    }
    if (/FROM schema_migrations WHERE version = \?/i.test(sql)) {
      return this.db.data.schema_migrations.filter((row) => row.version === args[0])
    }
    if (/SELECT COUNT\(\*\) AS count FROM raw_hook_events/i.test(sql)) {
      return [{ count: this.db.data.raw_hook_events.length }]
    }
    if (/FROM command_presets WHERE mode = \?/i.test(sql)) {
      return this.db.data.command_presets.filter((row) => row.mode === args[0])
    }
    if (/FROM command_presets/i.test(sql)) {
      return clone(this.db.data.command_presets)
    }
    if (/FROM projects WHERE path = \?/i.test(sql)) {
      return this.db.data.projects.filter((row) => row.path === args[0]).map(rowWithAliases)
    }
    if (/FROM projects WHERE id = \?/i.test(sql)) {
      return this.db.data.projects.filter((row) => row.id === args[0]).map(rowWithAliases)
    }
    if (/FROM projects/i.test(sql)) {
      return clone(this.db.data.projects).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).map(rowWithAliases)
    }
    if (/FROM sessions WHERE project_id = \? AND recovery_key = \?/i.test(sql)) {
      return this.db.data.sessions.filter((row) => row.project_id === args[0] && row.recovery_key === args[1]).sort(byLastActivity).map(rowWithAliases)
    }
    if (/FROM sessions\s+WHERE project_id = \? AND status IN/i.test(sql)) {
      const allowed = ['pending', 'diagnosing', 'spawning', 'running', 'active']
      return this.db.data.sessions.filter((row) => row.project_id === args[0] && allowed.includes(row.status)).sort(byLastActivity).map(rowWithAliases)
    }
    if (/FROM sessions WHERE id = \?/i.test(sql)) {
      return this.db.data.sessions.filter((row) => row.id === args[0]).map(rowWithAliases)
    }
    if (/FROM sessions WHERE status = 'active'/i.test(sql)) {
      return this.db.data.sessions.filter((row) => row.status === 'active').sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || ''))).map(rowWithAliases)
    }
    if (/FROM sessions/i.test(sql)) {
      return clone(this.db.data.sessions).sort(byLastActivity).map(rowWithAliases)
    }
    if (/FROM agents WHERE id = \?/i.test(sql)) {
      return this.db.data.agents.filter((row) => row.id === args[0]).map(rowWithAliases)
    }
    if (/FROM agents/i.test(sql)) {
      return clone(this.db.data.agents).sort(byLastActivity).map(rowWithAliases)
    }
    if (/FROM subagents WHERE id = \?/i.test(sql)) {
      return this.db.data.subagents.filter((row) => row.id === args[0]).map(rowWithAliases)
    }
    if (/FROM subagents WHERE session_id = \? AND status = 'running'/i.test(sql)) {
      return this.db.data.subagents.filter((row) => row.session_id === args[0] && row.status === 'running').sort(byLastActivity).map(rowWithAliases)
    }
    if (/FROM subagents/i.test(sql)) {
      return clone(this.db.data.subagents).sort(byLastActivity).map(rowWithAliases)
    }
    if (/FROM tool_calls WHERE id = \?/i.test(sql)) {
      return this.db.data.tool_calls.filter((row) => row.id === args[0]).map(rowWithAliases)
    }
    if (/FROM tool_calls/i.test(sql)) {
      return clone(this.db.data.tool_calls).sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || ''))).map(rowWithAliases)
    }
    if (/FROM hook_events/i.test(sql)) {
      return clone(this.db.data.hook_events).sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))).map(rowWithAliases)
    }
    if (/FROM usage_snapshots/i.test(sql)) {
      return clone(this.db.data.usage_snapshots).sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || ''))).map(rowWithAliases)
    }
    if (/FROM notifications/i.test(sql)) {
      return clone(this.db.data.notifications).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).map(rowWithAliases)
    }
    if (/FROM raw_logs/i.test(sql)) {
      return clone(this.db.data.raw_logs).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).map(rowWithAliases)
    }
    return []
  }

  execute(args) {
    const sql = this.sql
    const named = firstArg(args)
    const deleteMatch = sql.match(/^DELETE FROM "?(\w+)"?/i)
    if (deleteMatch) {
      const table = deleteMatch[1]
      if (this.db.data[table]) {
        this.db.data[table] = []
      }
      return
    }
    const insert = sql.match(/^INSERT INTO (\w+) \(([^)]+)\)/i)
    if (insert) {
      const table = insert[1]
      const columns = insert[2].split(',').map((column) => column.trim())
      const row = named ? Object.fromEntries(columns.map((column) => [column, named[column] ?? named[snakeToCamel(column)]])) : Object.fromEntries(columns.map((column, index) => [column, args[index]]))
      this.upsert(table, row)
      return
    }
    if (/^UPDATE projects SET status = \?, updated_at = \? WHERE id = \?/i.test(sql)) {
      this.updateById('projects', args[2], { status: args[0], updated_at: args[1] })
      return
    }
    if (/^UPDATE sessions SET recovery_key = \?, last_activity_at = \? WHERE id = \?/i.test(sql)) {
      this.updateById('sessions', args[2], { recovery_key: args[0], last_activity_at: args[1] })
      return
    }
    if (/^UPDATE sessions SET status = \?, last_activity_at = \? WHERE id = \?/i.test(sql)) {
      this.updateById('sessions', args[2], { status: args[0], last_activity_at: args[1] })
      return
    }
    if (/^UPDATE sessions SET last_activity_at = \? WHERE id = \?/i.test(sql)) {
      this.updateById('sessions', args[1], { last_activity_at: args[0] })
      return
    }
    if (/^UPDATE sessions SET status = \?, last_activity_at = \? WHERE status = 'active'/i.test(sql)) {
      for (const row of this.db.data.sessions) {
        if (row.status === 'active') {
          row.status = args[0]
          row.last_activity_at = args[1]
        }
      }
      return
    }
    if (/^UPDATE agents\s+SET status = \?, current_task = \?, last_activity_at = \?, source_log_id = \?/i.test(sql)) {
      this.updateById('agents', args[4], {
        status: args[0],
        current_task: args[1],
        last_activity_at: args[2],
        source_log_id: args[3],
      })
      return
    }
    if (/^UPDATE agents/i.test(sql)) {
      this.updateById('agents', args.at(-1), {
        name: args[0],
        agent_type: args[1] || undefined,
        status: args[2],
        current_task: args[3] || undefined,
        current_tool: args[4] || undefined,
        transcript_path: args[5] || undefined,
        last_assistant_message: args[6] || undefined,
        last_activity_at: args[7],
        token_estimate: args[8] ?? undefined,
        source_log_id: args[9] || undefined,
      })
      return
    }
    if (/^UPDATE subagents/i.test(sql)) {
      this.updateById('subagents', args.at(-1), {
        name: args[0],
        agent_type: args[1] || undefined,
        status: args[2],
        task_prompt: args[3] || undefined,
        transcript_path: args[4] || undefined,
        agent_transcript_path: args[5] || undefined,
        last_assistant_message: args[6] || undefined,
        last_activity_at: args[7],
        completed_at: ['completed', 'failed'].includes(args[8]) ? args[9] : undefined,
        error: args[10] || undefined,
        raw_event_id: args[11] || undefined,
      })
      return
    }
    if (/^UPDATE tool_calls/i.test(sql)) {
      this.updateById('tool_calls', args.at(-1), {
        status: args[0],
        output_summary: args[1] || undefined,
        completed_at: args[2],
        duration_ms: args[3],
        error: args[4] || undefined,
        raw_event_id: args[5] || undefined,
        file_path: args[6] || undefined,
      })
    }
  }

  upsert(table, row) {
    const key = table === 'settings' ? 'key' : table === 'command_presets' ? 'mode' : 'id'
    const existing = this.db.data[table].find((candidate) => candidate[key] === row[key])
    if (existing) {
      Object.assign(existing, Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)))
    } else {
      this.db.data[table].push(row)
    }
    SCHEMA[table] = Array.from(new Set([...(SCHEMA[table] || []), ...Object.keys(row)]))
  }

  updateById(table, id, patch) {
    const row = this.db.data[table].find((candidate) => candidate.id === id)
    if (!row) {
      return
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        row[key] = value
      }
    }
  }
}

function byLastActivity(a, b) {
  return String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || ''))
}
