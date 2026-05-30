import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appName = 'Claude Mac App.app'
const appBundle = path.join(repoRoot, 'src-tauri', 'target', 'release', 'bundle', 'macos', appName)
const dmgDir = path.join(repoRoot, 'src-tauri', 'target', 'release', 'bundle', 'dmg')
const dmgPath = path.join(dmgDir, 'Claude Mac App_0.1.0_aarch64.dmg')

if (!fs.existsSync(appBundle)) {
  throw new Error(`App bundle not found: ${appBundle}. Run npm run tauri:build first.`)
}

fs.mkdirSync(dmgDir, { recursive: true })
fs.rmSync(dmgPath, { force: true })

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mac-dmg-'))
try {
  const stagedApp = path.join(stagingDir, appName)
  execFileSync('ditto', [appBundle, stagedApp], { stdio: 'inherit' })
  fs.symlinkSync('/Applications', path.join(stagingDir, 'Applications'))
  execFileSync(
    'hdiutil',
    [
      'create',
      '-volname',
      'Claude Mac App',
      '-srcfolder',
      stagingDir,
      '-ov',
      '-format',
      'UDZO',
      dmgPath,
    ],
    { stdio: 'inherit' },
  )
  console.log(`Created DMG: ${dmgPath}`)
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true })
}
