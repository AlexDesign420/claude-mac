#!/usr/bin/env node
import http from 'node:http'

const hookUrl = process.argv[2] || process.env.CLAUDE_MAC_HOOK_URL || 'http://127.0.0.1:37621/hooks/claude'

function readStdin() {
  return new Promise((resolve) => {
    let body = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      body += chunk
      if (body.length > 2_000_000) {
        process.stdin.destroy()
      }
    })
    process.stdin.on('end', () => resolve(body || '{}'))
    process.stdin.on('error', () => resolve('{}'))
  })
}

function postJson(url, body) {
  return new Promise((resolve) => {
    const target = new URL(url)
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        timeout: 1500,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Claude-Mac-App': '1',
        },
      },
      (response) => {
        response.resume()
        response.on('end', resolve)
      },
    )
    request.on('timeout', () => {
      request.destroy()
      resolve()
    })
    request.on('error', resolve)
    request.end(body)
  })
}

const rawPayload = await readStdin()
await postJson(hookUrl, rawPayload)
process.stdout.write('{"continue":true}\n')
