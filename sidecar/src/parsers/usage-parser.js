import { normalizeWhitespace } from '../ansi.js'

function parseNumber(value) {
  const parsed = Number(value.replace(/[,\s](?=\d{3}\b)/g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

export class UsageParser {
  constructor() {
    this.lines = []
    this.lastSnapshotBySession = new Map()
  }

  ingest(chunk, context) {
    const clean = normalizeWhitespace(chunk)
    if (!clean) {
      return []
    }

    const nextLines = clean
      .split('\n')
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean)

    this.lines = [...this.lines, ...nextLines].slice(-60)
    const block = this.lines.join('\n')
    const events = []

    const statusLike =
      /(?:\/status|api usage|billing|provider|model|context|tokens?\/min|input tokens|output tokens)/i.test(
        block,
      )

    if (!statusLike) {
      const fastMatch = clean.match(/(\d[\d,.]*)\s*tokens?(?:\/min)?/i)
      if (!fastMatch) {
        return []
      }
    }

    const totalTokens =
      parseNumber(block.match(/total tokens?\s*[:=-]\s*([\d,.\s]+)/i)?.[1] || '') ??
      parseNumber(block.match(/tokens?\s*[:=-]\s*([\d,.\s]+)/i)?.[1] || '') ??
      parseNumber(clean.match(/(\d[\d,.]*)\s*tokens?/i)?.[1] || '')

    if (totalTokens == null) {
      return []
    }

    const model =
      block.match(/model\s*[:=-]\s*([^\n]+)/i)?.[1]?.trim() ||
      block.match(/^\s*([A-Za-z0-9_.-]+)\s+·\s+API Usage/im)?.[1]?.trim() ||
      null
    const provider =
      block.match(/provider\s*[:=-]\s*([^\n]+)/i)?.[1]?.trim() ||
      block.match(/base url\s*[:=-]\s*([^\n]+)/i)?.[1]?.trim() ||
      null
    const contextWindow = parseNumber(block.match(/context(?: window)?\s*[:=-]\s*([\d,.\s]+)/i)?.[1] || '')

    const now = Date.now()
    const previous = this.lastSnapshotBySession.get(context.sessionId)
    let tokensPerMinute =
      parseNumber(block.match(/tokens?\s*\/\s*min(?:ute)?\s*[:=-]?\s*([\d,.\s]+)/i)?.[1] || '') ?? null

    if (tokensPerMinute == null && previous) {
      const deltaMinutes = Math.max(1 / 60, (now - previous.timestamp) / 60000)
      tokensPerMinute = Math.max(0, totalTokens - previous.totalTokens) / deltaMinutes
    }

    const estimated = !statusLike

    this.lastSnapshotBySession.set(context.sessionId, {
      totalTokens,
      timestamp: now,
    })

    events.push({
      type: 'usage_snapshot',
      snapshot: {
        sessionId: context.sessionId,
        projectId: context.projectId,
        totalTokens,
        tokensPerMinute: tokensPerMinute ?? 0,
        estimated,
        model,
        provider,
        contextWindow,
        sourceLogId: context.logId,
      },
    })

    return events
  }
}
