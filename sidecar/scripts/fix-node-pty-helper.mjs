import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const sidecarDir = path.resolve(scriptDir, '..')
const helperPath = path.join(
  sidecarDir,
  'node_modules',
  'node-pty',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'spawn-helper',
)

if (!fs.existsSync(helperPath)) {
  console.warn(`[claude-mac-sidecar] node-pty spawn-helper not found at ${helperPath}`)
  process.exit(0)
}

fs.chmodSync(helperPath, 0o755)
console.log(`[claude-mac-sidecar] ensured executable node-pty spawn-helper: ${helperPath}`)
