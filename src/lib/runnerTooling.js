import { access, mkdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

import { getRootgridRuntimeDir } from './paths.js'

function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function resolveRuntimeDir(baseEnv = process.env, runtimeDir = null) {
  const configuredRuntime = trimText(runtimeDir)
  if (configuredRuntime) return configuredRuntime
  const envRuntime = trimText(baseEnv?.ROOTGRID_RUNTIME_DIR)
  if (envRuntime) return envRuntime
  const envInstallDir = trimText(baseEnv?.ROOTGRID_INSTALL_DIR)
  if (envInstallDir) return envInstallDir
  const envHome = trimText(baseEnv?.ROOTGRID_HOME_DIR)
  if (envHome) return envHome
  const home = trimText(baseEnv?.HOME)
  if (home) return join(home, '.rootgrid')
  return getRootgridRuntimeDir()
}

function shellQuote(value) {
  const text = String(value ?? '')
  return `'${text.replaceAll("'", `'\"'\"'`)}'`
}

export function buildSystemBubblewrapInstallShellFunction() {
  return `rootgrid_install_system_bubblewrap() {
  if [ "$(uname -s 2>/dev/null || true)" != "Linux" ]; then
    return 0
  fi
  if [ "$ROOTGRID_INSTALL_BUBBLEWRAP" = "0" ]; then
    return 0
  fi

  rootgrid_has_privilege() {
    if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
      return 0
    fi
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      return 0
    fi
    return 1
  }

  rootgrid_privileged() {
    if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
      "$@"
      return $?
    fi
    if command -v sudo >/dev/null 2>&1; then
      sudo -n "$@"
      return $?
    fi
    return 1
  }

  rootgrid_bwrap_present=0
  if command -v bwrap >/dev/null 2>&1; then
    rootgrid_bwrap_present=1
  fi

  if [ "$rootgrid_bwrap_present" = "1" ] && ! rootgrid_has_privilege; then
    echo "[rootgrid] bubblewrap: $(bwrap --version 2>/dev/null | head -n 1)" >&2
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    rootgrid_privileged apt-get update && rootgrid_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap
  elif command -v dnf >/dev/null 2>&1; then
    rootgrid_privileged dnf install -y bubblewrap
  elif command -v yum >/dev/null 2>&1; then
    rootgrid_privileged yum install -y bubblewrap
  elif command -v apk >/dev/null 2>&1; then
    rootgrid_privileged apk add --no-cache bubblewrap
  elif command -v pacman >/dev/null 2>&1; then
    rootgrid_privileged pacman -S --noconfirm --needed bubblewrap
  elif command -v zypper >/dev/null 2>&1; then
    rootgrid_privileged zypper --non-interactive install bubblewrap
  fi

  if command -v bwrap >/dev/null 2>&1; then
    echo "[rootgrid] bubblewrap: $(bwrap --version 2>/dev/null | head -n 1)" >&2
    return 0
  fi

  echo "[rootgrid] bubblewrap could not be installed automatically; install package 'bubblewrap' on this runner to avoid Codex's vendored fallback warning." >&2
  return 0
}`
}

function buildSystemBubblewrapInstallCommand() {
  return `{ ${buildSystemBubblewrapInstallShellFunction()}
rootgrid_install_system_bubblewrap
}`
}

function buildManagedCodexUpgradeCommand(prefixDir) {
  return [
    `mkdir -p ${shellQuote(prefixDir)}`,
    `npm install --global --prefix ${shellQuote(prefixDir)} @openai/codex`,
    buildSystemBubblewrapInstallCommand()
  ].join(' && ')
}

function splitPathEntries(pathValue) {
  return String(pathValue ?? '')
    .split(delimiter)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
}

function dedupeList(values) {
  const seen = new Set()
  const out = []
  for (const raw of values) {
    const value = String(raw ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function getRunnerToolsDir({
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  return join(runtimeDir, 'tools')
}

export function getManagedCodexPrefixDir({
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  return join(getRunnerToolsDir({ runtimeDir }), 'codex', 'npm-global')
}

export function getManagedCodexBinDir({
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  return join(getManagedCodexPrefixDir({ runtimeDir }), 'bin')
}

export function getManagedCodexBinPath({
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  return join(getManagedCodexBinDir({ runtimeDir }), 'codex')
}

export function getManagedCodeServerHomeDir({
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  return join(getRunnerToolsDir({ runtimeDir }), 'code-server', 'home')
}

export function getManagedCodeServerBinDir({
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  return join(getManagedCodeServerHomeDir({ runtimeDir }), '.local', 'bin')
}

export function getManagedCodeServerBinPath({
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  return join(getManagedCodeServerBinDir({ runtimeDir }), 'code-server')
}

export function getManagedRunnerToolBinPath(toolId, {
  env = process.env,
  runtimeDir = null
} = {}) {
  const safeToolId = String(toolId ?? '').trim()
  const resolvedRuntimeDir = resolveRuntimeDir(env, runtimeDir)
  if (safeToolId === 'codex') {
    return trimText(env?.ROOTGRID_CODEX_BIN) ?? getManagedCodexBinPath({ runtimeDir: resolvedRuntimeDir })
  }
  if (safeToolId === 'codeServer') {
    return trimText(env?.ROOTGRID_CODE_SERVER_BIN) ?? getManagedCodeServerBinPath({ runtimeDir: resolvedRuntimeDir })
  }
  return null
}

export function buildManagedRunnerToolEnv(baseEnv = process.env, {
  runtimeDir = null
} = {}) {
  const resolvedRuntimeDir = resolveRuntimeDir(baseEnv, runtimeDir)
  const env = { ...(baseEnv ?? {}) }
  const managedCodexBinDir = getManagedCodexBinDir({ runtimeDir: resolvedRuntimeDir })
  const managedCodeServerBinDir = getManagedCodeServerBinDir({ runtimeDir: resolvedRuntimeDir })
  env.PATH = dedupeList([
    managedCodexBinDir,
    managedCodeServerBinDir,
    ...splitPathEntries(env.PATH)
  ]).join(delimiter)
  env.ROOTGRID_RUNTIME_DIR = resolvedRuntimeDir
  env.ROOTGRID_INSTALL_DIR = resolvedRuntimeDir
  env.ROOTGRID_CODEX_BIN = getManagedCodexBinPath({ runtimeDir: resolvedRuntimeDir })
  env.ROOTGRID_CODE_SERVER_BIN = getManagedCodeServerBinPath({ runtimeDir: resolvedRuntimeDir })
  return env
}

export function applyManagedRunnerToolEnv(baseEnv = process.env, options = {}) {
  const next = buildManagedRunnerToolEnv(baseEnv, options)
  for (const [key, value] of Object.entries(next)) {
    baseEnv[key] = value
  }
  return baseEnv
}

export function buildCodexCommandCandidates(baseEnv = process.env, {
  runtimeDir = null,
  allowExternal = true
} = {}) {
  const env = baseEnv ?? {}
  const resolvedRuntimeDir = resolveRuntimeDir(env, runtimeDir)
  const values = [
    env.ROOTGRID_CODEX_BIN,
    getManagedCodexBinPath({ runtimeDir: resolvedRuntimeDir })
  ]
  if (allowExternal) {
    values.push(env.CODEX_BIN)
    for (const dir of splitPathEntries(env.PATH)) values.push(join(dir, 'codex'))
    const home = trimText(env.HOME) ?? homedir()
    if (home) values.push(join(home, '.npm-global', 'bin', 'codex'))
    values.push('/usr/local/bin/codex')
    values.push('/usr/bin/codex')
    values.push('/opt/homebrew/bin/codex')
    values.push('/home/linuxbrew/.linuxbrew/bin/codex')
  }
  return dedupeList(values)
}

export function buildCodeServerCommandCandidates(baseEnv = process.env, {
  runtimeDir = null,
  allowExternal = true
} = {}) {
  const env = baseEnv ?? {}
  const resolvedRuntimeDir = resolveRuntimeDir(env, runtimeDir)
  const values = [
    env.ROOTGRID_CODE_SERVER_BIN,
    getManagedCodeServerBinPath({ runtimeDir: resolvedRuntimeDir })
  ]
  if (allowExternal) {
    values.push(env.CODE_SERVER_BIN)
    for (const dir of splitPathEntries(env.PATH)) values.push(join(dir, 'code-server'))
    const home = trimText(env.HOME) ?? homedir()
    if (home) values.push(join(home, '.local', 'bin', 'code-server'))
    values.push('/usr/local/bin/code-server')
    values.push('/usr/bin/code-server')
    values.push('/opt/homebrew/bin/code-server')
    values.push('/home/linuxbrew/.linuxbrew/bin/code-server')
  }
  return dedupeList(values)
}

function managedSourceFor(toolId, runtimeDir = getRootgridRuntimeDir()) {
  if (toolId === 'codex') return getManagedCodexBinPath({ runtimeDir })
  if (toolId === 'codeServer') return getManagedCodeServerBinPath({ runtimeDir })
  return null
}

export function inferRunnerToolSource(toolId, commandPath, {
  runtimeDir = null,
  env = process.env
} = {}) {
  const safePath = trimText(commandPath)
  if (!safePath) return 'missing'
  const managedPath = managedSourceFor(toolId, resolveRuntimeDir(env, runtimeDir))
  return safePath === managedPath ? 'managed' : 'external'
}

export async function resolveCommandCandidate(candidates, {
  accessFn = access
} = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  for (const candidate of list) {
    const path = trimText(candidate)
    if (!path) continue
    try {
      await accessFn(path, fsConstants.X_OK)
      return path
    } catch {
    }
  }
  return null
}

export async function ensureManagedToolInstallBase(toolId, {
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  const safeToolId = String(toolId ?? '').trim()
  if (safeToolId === 'codex') {
    const prefixDir = getManagedCodexPrefixDir({ runtimeDir })
    await mkdir(prefixDir, { recursive: true, mode: 0o755 })
    return {
      runtimeDir,
      prefixDir
    }
  }
  if (safeToolId === 'codeServer') {
    const homeDir = getManagedCodeServerHomeDir({ runtimeDir })
    await mkdir(homeDir, { recursive: true, mode: 0o755 })
    return {
      runtimeDir,
      homeDir
    }
  }
  throw new Error(`unknown runner tool: ${safeToolId || 'unknown'}`)
}

export function getRunnerToolInstallSpec(toolId, {
  runtimeDir = getRootgridRuntimeDir()
} = {}) {
  const safeToolId = String(toolId ?? '').trim()
  if (safeToolId === 'codex') {
    const prefixDir = getManagedCodexPrefixDir({ runtimeDir })
    const binPath = getManagedCodexBinPath({ runtimeDir })
    return {
      id: 'codex',
      label: 'Codex',
      docsUrl: 'https://developers.openai.com/codex/cli',
      managedBinPath: binPath,
      managedBinDir: getManagedCodexBinDir({ runtimeDir }),
      upgradeCommand: buildManagedCodexUpgradeCommand(prefixDir)
    }
  }

  if (safeToolId === 'codeServer') {
    const homeDir = getManagedCodeServerHomeDir({ runtimeDir })
    const binDir = getManagedCodeServerBinDir({ runtimeDir })
    const envPrefix = [
      `HOME=${shellQuote(homeDir)}`,
      `XDG_CONFIG_HOME=${shellQuote(join(homeDir, '.config'))}`,
      `XDG_CACHE_HOME=${shellQuote(join(homeDir, '.cache'))}`,
      `XDG_DATA_HOME=${shellQuote(join(homeDir, '.local', 'share'))}`,
      `PATH=${shellQuote(binDir)}:"$PATH"`
    ].join(' ')
      return {
        id: 'codeServer',
        label: 'code-server',
        docsUrl: 'https://coder.com/docs/code-server/latest/install',
        managedBinPath: getManagedCodeServerBinPath({ runtimeDir }),
        managedBinDir: binDir,
        upgradeCommand: [
          `mkdir -p ${shellQuote(homeDir)} ${shellQuote(binDir)}`,
          `${envPrefix} sh -lc ${shellQuote('curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone')}`
        ].join(' && ')
      }
    }

  throw new Error(`unknown runner tool: ${safeToolId || 'unknown'}`)
}
