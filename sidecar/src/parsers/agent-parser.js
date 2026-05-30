import { normalizeWhitespace } from '../ansi.js'

const SPAWN_PATTERNS = [
  /(?:new|spawned?)\s+(?:agent|subagent)\s*[:#-]?\s*([A-Za-z0-9._-]+)/i,
  /(?:agent|subagent)\s*[:#-]?\s*([A-Za-z0-9._-]+)\s+(?:started|created|running)/i,
  /delegating\s+to\s+(?:agent|subagent)\s*([A-Za-z0-9._-]+)/i,
]

const STATUS_PATTERNS = [
  { status: 'waiting', pattern: /\b(waiting|blocked|awaiting input|pending)\b/i },
  { status: 'completed', pattern: /\b(completed|finished|done|resolved)\b/i },
  { status: 'failed', pattern: /\b(failed|error|crashed|terminated)\b/i },
  { status: 'running', pattern: /\b(running|working|executing|processing|thinking)\b/i },
]

const TASK_PATTERNS = [
  /task\s*[:=-]\s*(.+)$/i,
  /working on\s+(.+)$/i,
  /current(?:ly)?\s+(?:handling|processing)\s+(.+)$/i,
]

export class AgentParser {
  constructor() {
    this.buffer = ''
    this.fallbackCounter = 0
    this.agentIdsByName = new Map()
  }

  ingest(chunk, context) {
    const text = normalizeWhitespace(chunk)
    if (!text) {
      return []
    }

    this.buffer = `${this.buffer}\n${text}`.slice(-8000)
    const lines = this.buffer
      .split('\n')
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean)
      .slice(-40)

    const events = []

    for (const line of lines) {
      const spawn = this.detectSpawn(line)
      if (spawn) {
        events.push(this.buildEvent('spawned', spawn, line, context))
        continue
      }

      const status = this.detectStatus(line)
      if (status) {
        const agentName = this.findKnownAgentName(line)
        if (agentName) {
          events.push(this.buildEvent(status, agentName, line, context))
        }
      }
    }

    return this.dedupe(events)
  }

  detectSpawn(line) {
    for (const pattern of SPAWN_PATTERNS) {
      const match = line.match(pattern)
      if (match?.[1]) {
        return match[1]
      }
    }

    if (/\b(agent|subagent)\b/i.test(line) && /\b(task|working|running)\b/i.test(line)) {
      this.fallbackCounter += 1
      return `agent-${this.fallbackCounter}`
    }

    return null
  }

  detectStatus(line) {
    for (const entry of STATUS_PATTERNS) {
      if (entry.pattern.test(line)) {
        return entry.status
      }
    }
    return null
  }

  detectTask(line) {
    for (const pattern of TASK_PATTERNS) {
      const match = line.match(pattern)
      if (match?.[1]) {
        return match[1].trim()
      }
    }
    return 'Claude Agent Aktivitaet erkannt'
  }

  findKnownAgentName(line) {
    for (const name of this.agentIdsByName.keys()) {
      if (line.toLowerCase().includes(name.toLowerCase())) {
        return name
      }
    }
    return null
  }

  buildEvent(kind, agentName, line, context) {
    if (!this.agentIdsByName.has(agentName)) {
      this.agentIdsByName.set(agentName, `agent-${agentName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`)
    }

    const status = kind === 'spawned' ? 'running' : kind
    return {
      type: kind === 'spawned' ? 'agent_spawned' : 'agent_status',
      agent: {
        id: this.agentIdsByName.get(agentName),
        name: agentName,
        sessionId: context.sessionId,
        projectId: context.projectId,
        status,
        currentTask: this.detectTask(line),
        sourceLogId: context.logId,
      },
    }
  }

  dedupe(events) {
    const seen = new Set()
    return events.filter((event) => {
      const key = `${event.type}:${event.agent.id}:${event.agent.status}:${event.agent.sourceLogId}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }
}
