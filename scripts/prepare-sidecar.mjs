import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const root = process.cwd()
const sidecarDir = path.join(root, 'sidecar')
const outputDir = path.join(root, '.sidecar-bundle')
const appDir = path.join(outputDir, 'app')
const runtimeDir = path.join(outputDir, 'runtime')
const nodeBinarySource = process.execPath
const nodeBinaryTarget = path.join(runtimeDir, 'node')
const rebuildNative = process.argv.includes('--rebuild-native') || process.env.CLAUDE_MAC_REBUILD_NATIVE === '1'

fs.rmSync(outputDir, { recursive: true, force: true })
fs.mkdirSync(appDir, { recursive: true })
fs.mkdirSync(runtimeDir, { recursive: true })

for (const entry of ['index.js', 'bootstrap.js', 'main.js', 'hook-forwarder.js', 'package.json', 'package-lock.json', 'src', 'scripts']) {
  fs.cpSync(path.join(sidecarDir, entry), path.join(appDir, entry), { recursive: true, dereference: true })
}

execSync('npm install --omit=dev', {
  cwd: appDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  },
})

if (rebuildNative) {
  execSync('npm rebuild better-sqlite3 node-pty --build-from-source', {
    cwd: appDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  })
}

const nodePtyHelper = path.join(appDir, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
if (fs.existsSync(nodePtyHelper)) {
  fs.chmodSync(nodePtyHelper, 0o755)
}

fs.copyFileSync(nodeBinarySource, nodeBinaryTarget)
fs.chmodSync(nodeBinaryTarget, 0o755)

const validationScript = `
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.dirname(appDir)
const diagnostics = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  nodeBinarySource: ${JSON.stringify(nodeBinarySource)},
  nodeBinaryTarget: ${JSON.stringify(nodeBinaryTarget)},
  appDir,
  nodeModulesExists: fs.existsSync(path.join(appDir, 'node_modules')),
  betterSqliteExists: fs.existsSync(path.join(appDir, 'node_modules', 'better-sqlite3')),
  nodePtyExists: fs.existsSync(path.join(appDir, 'node_modules', 'node-pty')),
  spawnHelperPath: path.join(appDir, 'node_modules', 'node-pty', 'prebuilds', process.platform + '-' + process.arch, 'spawn-helper'),
  spawnHelperExists: false,
  spawnHelperExecutable: false,
  validationPassed: false,
  validationOutput: [],
  validationError: null,
  modules: {},
}

function record(message, payload = {}) {
  diagnostics.validationOutput.push({ message, ...payload })
}

function errorPayload(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : '',
  }
}

async function checkModule(name, test) {
  try {
    const imported = await import(name)
    const result = await test(imported)
    diagnostics.modules[name] = { ok: true, result }
    record(name + ' ok', result)
    return true
  } catch (error) {
    diagnostics.modules[name] = { ok: false, error: errorPayload(error) }
    diagnostics.validationError = diagnostics.validationError || diagnostics.modules[name].error
    record(name + ' failed', diagnostics.modules[name].error)
    return false
  }
}

diagnostics.spawnHelperExists = fs.existsSync(diagnostics.spawnHelperPath)
if (diagnostics.spawnHelperExists) {
  fs.chmodSync(diagnostics.spawnHelperPath, 0o755)
  try {
    fs.accessSync(diagnostics.spawnHelperPath, fs.constants.X_OK)
    diagnostics.spawnHelperExecutable = true
  } catch {
    diagnostics.spawnHelperExecutable = false
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mac-sidecar-validate-'))
try {
  const checks = []
  checks.push(await checkModule('better-sqlite3', async (imported) => {
    const Database = imported.default || imported
    const db = new Database(path.join(tmpDir, 'validate.sqlite'))
    db.exec('CREATE TABLE check_native (id INTEGER PRIMARY KEY, ok TEXT NOT NULL); INSERT INTO check_native (ok) VALUES (\\'yes\\');')
    const row = db.prepare('SELECT ok FROM check_native').get()
    db.close()
    if (row?.ok !== 'yes') {
      throw new Error('better-sqlite3 validation query failed')
    }
    return { query: 'ok' }
  }))
  checks.push(await checkModule('node-pty', async (imported) => {
    const pty = imported.default || imported
    const output = await new Promise((resolve, reject) => {
      let value = ''
      const shell = process.env.SHELL || '/bin/zsh'
      const proc = pty.spawn(shell, ['-lc', 'printf native-pty-ok'], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        env: process.env,
      })
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('node-pty validation timed out'))
      }, 3000)
      proc.onData((chunk) => {
        value += chunk
      })
      proc.onExit(({ exitCode }) => {
        clearTimeout(timer)
        if (exitCode === 0 && value.includes('native-pty-ok')) {
          resolve(value)
          return
        }
        reject(new Error('node-pty validation failed: ' + value))
      })
    })
    return { output }
  }))
  checks.push(await checkModule('ws', async (imported) => {
    const server = new imported.WebSocketServer({ port: 0 })
    await new Promise((resolve) => server.close(resolve))
    return { server: 'ok' }
  }))
  checks.push(await checkModule('uuid', async (imported) => {
    const id = imported.v4()
    if (!id || typeof id !== 'string') {
      throw new Error('uuid v4 returned invalid value')
    }
    return { sampleLength: id.length }
  }))
  diagnostics.validationPassed = checks.every(Boolean) && diagnostics.spawnHelperExecutable
  fs.writeFileSync(path.join(outputDir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2))
  if (!diagnostics.validationPassed) {
    throw new Error('Sidecar native validation failed; see .sidecar-bundle/diagnostics.json')
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
`

fs.writeFileSync(path.join(appDir, 'validate-runtime.mjs'), validationScript)

execSync(`"${nodeBinaryTarget}" validate-runtime.mjs`, {
  cwd: appDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  },
})

const diagnosticsPath = path.join(outputDir, 'diagnostics.json')
const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'))
const manifest = {
  preparedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  nodeSource: nodeBinarySource,
  nodeBinary: 'runtime/node',
  entrypoint: 'app/index.js',
  nativeModulesValidated: diagnostics.validationPassed,
  diagnostics: 'diagnostics.json',
  validationHost: os.hostname(),
}

fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`Prepared sidecar bundle in ${outputDir}`)
