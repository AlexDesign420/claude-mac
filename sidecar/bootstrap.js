import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sidecarRoot = path.dirname(fileURLToPath(import.meta.url))
const appDataDir = process.env.CLAUDE_MAC_APP_DATA_DIR || path.join(process.cwd(), '.claude-mac-app')
const nativeDiagnostics = {
  processExecPath: process.execPath,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  cwd: process.cwd(),
  dirname: sidecarRoot,
  nodePath: process.env.NODE_PATH || '',
  sidecarRoot,
  appDataDir,
  nodeModulesPath: path.join(sidecarRoot, 'node_modules'),
  modules: {},
  checkedAt: new Date().toISOString(),
}

function emit(type, payload = {}) {
  process.stdout.write(`${JSON.stringify({ type, ...payload, at: new Date().toISOString() })}\n`)
}

function fileStatus(filePath) {
  try {
    const stats = fs.statSync(filePath)
    return {
      path: filePath,
      exists: true,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      mode: stats.mode,
      executable: Boolean(stats.mode & 0o111),
    }
  } catch {
    return {
      path: filePath,
      exists: false,
      isDirectory: false,
      isFile: false,
      mode: null,
      executable: false,
    }
  }
}

function errorPayload(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : '',
    name: error instanceof Error ? error.name : 'Error',
  }
}

async function checkImport(name, specifier, validate) {
  emit('native_check_started', { module: name, specifier })
  try {
    const imported = await import(specifier)
    const validation = validate ? await validate(imported) : { ok: true }
    const result = {
      ok: true,
      specifier,
      validation,
    }
    nativeDiagnostics.modules[name] = result
    emit('native_check_success', { module: name, result })
    return { ok: true, module: imported, result }
  } catch (error) {
    const result = {
      ok: false,
      specifier,
      error: errorPayload(error),
    }
    nativeDiagnostics.modules[name] = result
    emit('native_check_failed', { module: name, result })
    return { ok: false, module: null, result }
  }
}

function writeDiagnosticsFile() {
  try {
    fs.mkdirSync(appDataDir, { recursive: true })
    fs.writeFileSync(path.join(appDataDir, 'sidecar-bootstrap-diagnostics.json'), JSON.stringify(nativeDiagnostics, null, 2))
  } catch {
    // stdout diagnostics are the source of truth if the file cannot be written.
  }
}

function startDiagnosticHttpServer(fatalReason) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify({ ok: false, fatalReason, diagnostics: nativeDiagnostics }))
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    emit('fatal_diagnostic_server_ready', {
      port: typeof address === 'object' && address ? address.port : null,
      fatalReason,
      diagnostics: nativeDiagnostics,
    })
  })
}

emit('bootstrap_started', {
  processExecPath: process.execPath,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  cwd: process.cwd(),
  dirname: sidecarRoot,
  nodePath: process.env.NODE_PATH || '',
  sidecarRoot,
})

nativeDiagnostics.paths = {
  nodeModules: fileStatus(nativeDiagnostics.nodeModulesPath),
  betterSqlite3: fileStatus(path.join(sidecarRoot, 'node_modules', 'better-sqlite3')),
  nodePty: fileStatus(path.join(sidecarRoot, 'node_modules', 'node-pty')),
  ws: fileStatus(path.join(sidecarRoot, 'node_modules', 'ws')),
  uuid: fileStatus(path.join(sidecarRoot, 'node_modules', 'uuid')),
  spawnHelper: fileStatus(path.join(sidecarRoot, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')),
  main: fileStatus(path.join(sidecarRoot, 'main.js')),
}

if (nativeDiagnostics.paths.spawnHelper.exists && !nativeDiagnostics.paths.spawnHelper.executable) {
  try {
    fs.chmodSync(nativeDiagnostics.paths.spawnHelper.path, 0o755)
    nativeDiagnostics.paths.spawnHelper = fileStatus(nativeDiagnostics.paths.spawnHelper.path)
  } catch (error) {
    nativeDiagnostics.spawnHelperChmodError = errorPayload(error)
  }
}

const betterSqlite3 = await checkImport('better-sqlite3', 'better-sqlite3', async (imported) => {
  const Database = imported.default || imported
  if (typeof Database !== 'function') {
    throw new Error('better-sqlite3 export is not a Database constructor')
  }
  return { ok: true, exportType: typeof Database }
})
const nodePty = await checkImport('node-pty', 'node-pty', async (imported) => {
  const pty = imported.default || imported
  if (typeof pty.spawn !== 'function') {
    throw new Error('node-pty export has no spawn()')
  }
  return { ok: true, spawnHelper: nativeDiagnostics.paths.spawnHelper }
})
const ws = await checkImport('ws', 'ws', async (imported) => {
  if (typeof imported.WebSocketServer !== 'function') {
    throw new Error('ws export has no WebSocketServer')
  }
  return { ok: true }
})
const uuid = await checkImport('uuid', 'uuid', async (imported) => {
  if (typeof imported.v4 !== 'function') {
    throw new Error('uuid export has no v4()')
  }
  return { ok: true }
})

globalThis.__CLAUDE_MAC_NATIVE_DIAGNOSTICS__ = nativeDiagnostics
globalThis.__CLAUDE_MAC_NATIVE_MODULES__ = {
  betterSqlite3: betterSqlite3.ok ? betterSqlite3.module : null,
  nodePty: nodePty.ok ? nodePty.module : null,
}

writeDiagnosticsFile()

if (!ws.ok || !uuid.ok) {
  const fatalReason = !ws.ok ? 'ws module failed; WebSocket runtime cannot start.' : 'uuid module failed; runtime IDs cannot be generated.'
  emit('fatal', {
    reason: fatalReason,
    diagnostics: nativeDiagnostics,
  })
  startDiagnosticHttpServer(fatalReason)
} else {
  emit('main_loading', {
    entrypoint: path.join(sidecarRoot, 'main.js'),
    sqliteAvailable: betterSqlite3.ok,
    ptyAvailable: nodePty.ok,
  })
  try {
    await import(pathToFileURL(path.join(sidecarRoot, 'main.js')).href)
  } catch (error) {
    nativeDiagnostics.mainLoadError = errorPayload(error)
    writeDiagnosticsFile()
    emit('fatal', {
      reason: 'main.js failed after bootstrap checks.',
      diagnostics: nativeDiagnostics,
      error: nativeDiagnostics.mainLoadError,
    })
    startDiagnosticHttpServer('main.js failed after bootstrap checks.')
  }
}
