import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function getShellPath(env = process.env) {
  return env.SHELL || '/bin/zsh'
}

export function shellArgsForInteractiveLoginCommand(shellPath, command) {
  const shellName = path.basename(shellPath)

  if (shellName === 'zsh' || shellName === 'bash') {
    return ['-ilc', command]
  }

  return ['-lc', command]
}

export function expandHome(input, env = process.env) {
  if (!input.startsWith('~')) {
    return input
  }

  return path.join(env.HOME || os.homedir(), input.slice(1))
}

export function shellFiles(env = process.env) {
  const home = env.HOME || os.homedir()
  const files = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.profile', '.bash_profile', '.bashrc']

  return files.map((file) => {
    const filePath = path.join(home, file)
    return {
      name: file,
      path: filePath,
      exists: fs.existsSync(filePath),
    }
  })
}

export function commonCommandCandidates(command, env = process.env) {
  if (command.includes('/')) {
    return [expandHome(command, env)]
  }

  const home = env.HOME || os.homedir()
  return [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    path.join(home, '.local/bin', command),
    path.join(home, 'bin', command),
    path.join(home, '.npm-global/bin', command),
  ]
}

export function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function runShellDiagnostic(shellPath, command, cwd, env = process.env) {
  const args = shellArgsForInteractiveLoginCommand(shellPath, command)
  const result = spawnSync(shellPath, args, {
    cwd,
    env,
    encoding: 'utf8',
  })

  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    args,
  }
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function runLookup(shellPath, startCommand, cwd, env) {
  const quotedCommand = shellQuote(startCommand)
  const command = [
    'printf "__diag_pwd__%s\\n" "$PWD"',
    'printf "__diag_home__%s\\n" "$HOME"',
    'printf "__diag_user__%s\\n" "$USER"',
    'printf "__diag_path__%s\\n" "$PATH"',
    `printf "__diag_which__"; which ${quotedCommand} 2>&1; printf "\\n"`,
    `printf "__diag_type__"; type ${quotedCommand} 2>&1; printf "\\n"`,
    `printf "__diag_command_v__"; command -v ${quotedCommand} 2>&1; printf "\\n"`,
    `printf "__diag_alias__"; alias ${quotedCommand} 2>&1; printf "\\n"`,
    `printf "__diag_whence__"; whence -v ${quotedCommand} 2>&1; printf "\\n"`,
  ].join('; ')

  return runShellDiagnostic(shellPath, command, cwd, env)
}

function markerValue(stdout, marker) {
  const line = stdout
    .split('\n')
    .find((entry) => entry.startsWith(marker))
  return line ? line.slice(marker.length).trim() : ''
}

export function buildStartDiagnostic(shellPath, startCommand, cwd, env = process.env) {
  const lookup = runLookup(shellPath, startCommand, cwd, env)
  const expandedCommand = expandHome(startCommand, env)
  const absoluteDirect =
    path.isAbsolute(expandedCommand) && fs.existsSync(expandedCommand)
      ? {
          path: expandedCommand,
          executable: isExecutable(expandedCommand),
        }
      : null
  const candidates = commonCommandCandidates(startCommand, env).map((candidate) => ({
    path: candidate,
    exists: fs.existsSync(candidate),
    executable: fs.existsSync(candidate) ? isExecutable(candidate) : false,
  }))
  const fallback = candidates.find((candidate) => candidate.executable)
  const typeResult = markerValue(lookup.stdout, '__diag_type__')
  const commandV = markerValue(lookup.stdout, '__diag_command_v__')
  const which = markerValue(lookup.stdout, '__diag_which__')
  const alias = markerValue(lookup.stdout, '__diag_alias__')
  const whence = markerValue(lookup.stdout, '__diag_whence__')
  const shellResolved = Boolean(typeResult && !/not found|not a shell builtin|no .* in/i.test(typeResult))
  const functionOrAlias = /\b(alias|function|shell function)\b/i.test(`${typeResult}\n${alias}\n${whence}`)
  const directResolved = Boolean(absoluteDirect?.executable || fallback)
  const resolvedPath = absoluteDirect?.executable ? absoluteDirect.path : fallback?.path || commandV || which || ''

  return {
    shell: shellPath,
    cwd,
    home: env.HOME || os.homedir(),
    user: env.USER || os.userInfo().username,
    path: markerValue(lookup.stdout, '__diag_path__') || env.PATH || '',
    which,
    type: typeResult,
    commandV,
    alias,
    whence,
    shellFiles: shellFiles(env),
    candidates,
    direct: absoluteDirect,
    resolvedPath,
    resolution: absoluteDirect?.executable
      ? 'absolute_path'
      : shellResolved
        ? functionOrAlias
          ? 'shell_alias_or_function'
          : 'shell_command'
        : fallback
          ? 'common_path'
          : 'not_found',
    functionOrAlias,
    stdout: lookup.stdout,
    stderr: lookup.stderr,
    exitCode: lookup.status,
    args: lookup.args,
    ok: shellResolved || directResolved,
  }
}

export function buildStartCommand(preset) {
  return [preset.startCommand, ...(preset.startArgs || [])].join(' ').trim()
}

export function resolveStartInvocation(preset, cwd, env = process.env) {
  const shell = getShellPath(env)
  const diagnostic = buildStartDiagnostic(shell, preset.startCommand, cwd, env)
  const finalCommand = buildStartCommand(preset)

  if (!diagnostic.ok) {
    return {
      ok: false,
      shell,
      diagnostic,
      finalCommand,
      suggestion:
        'Trage im Preset den direkten Skriptpfad ein oder stelle sicher, dass Alias/Funktion in .zshrc, .zprofile oder .zshenv geladen wird.',
    }
  }

  if (diagnostic.resolution === 'absolute_path' || diagnostic.resolution === 'common_path') {
    return {
      ok: true,
      shell,
      diagnostic,
      finalCommand,
      ptyFile: diagnostic.resolvedPath,
      ptyArgs: preset.startArgs || [],
      ptyCommand: `${diagnostic.resolvedPath} ${(preset.startArgs || []).join(' ')}`.trim(),
      mode: 'direct',
    }
  }

  const shellArgs = shellArgsForInteractiveLoginCommand(shell, finalCommand)
  return {
    ok: true,
    shell,
    diagnostic,
    finalCommand,
    ptyFile: shell,
    ptyArgs: shellArgs,
    ptyCommand: `${shell} ${shellArgs.join(' ')}`,
    mode: 'shell',
  }
}
