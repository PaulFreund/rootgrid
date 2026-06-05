import crypto from 'node:crypto'

import { buildSystemBubblewrapInstallShellFunction } from '../lib/runnerTooling.js'

function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function shellQuote(value) {
  const text = String(value ?? '')
  return `'${text.replaceAll("'", `'\"'\"'`)}'`
}

function jsonString(value) {
  return JSON.stringify(String(value ?? ''))
}

export function buildExternalBaseUrl(req, {
  publicUrl = null,
  trustProxy = false
} = {}) {
  const configured = trimText(publicUrl)
  if (configured) return configured.replace(/\/+$/, '')

  const forwardedProto = trustProxy
    ? trimText(String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0])
    : null
  const forwardedHost = trustProxy
    ? trimText(String(req?.headers?.['x-forwarded-host'] ?? '').split(',')[0])
    : null
  const protocol = forwardedProto || (req?.socket?.encrypted ? 'https' : 'http')
  const host = forwardedHost || trimText(req?.headers?.host) || '127.0.0.1:7337'
  return `${protocol}://${host}`.replace(/\/+$/, '')
}

export function buildRunnerInstallScript({
  baseUrl,
  installToken,
  runnerToken,
  version = '0.0.0',
  releaseId = 'rootgrid',
  configVersion = 1
}) {
  const safeBaseUrl = trimText(baseUrl)
  const safeInstallToken = trimText(installToken)
  const safeRunnerToken = trimText(runnerToken)
  if (!safeBaseUrl) throw new Error('baseUrl is required')
  if (!safeInstallToken) throw new Error('installToken is required')
  if (!safeRunnerToken) throw new Error('runnerToken is required')
  const safeVersion = trimText(version) ?? '0.0.0'
  const safeReleaseId = trimText(releaseId) ?? 'rootgrid'

  const bundleUrl = `${safeBaseUrl}/api/install/runner-bundle?installToken=${encodeURIComponent(safeInstallToken)}`

  return `#!/usr/bin/env bash
set -euo pipefail

ROOTGRID_BASE_URL=${shellQuote(safeBaseUrl)}
ROOTGRID_INSTALL_TOKEN=${shellQuote(safeInstallToken)}
ROOTGRID_BUNDLE_URL=${shellQuote(bundleUrl)}
ROOTGRID_VERSION=${shellQuote(safeVersion)}
ROOTGRID_RELEASE_ID=${shellQuote(safeReleaseId)}
ROOTGRID_HOME_DIR="\${ROOTGRID_HOME_DIR:-\${ROOTGRID_DIR:-$HOME/.rootgrid}}"
ROOTGRID_RUNTIME_DIR="\${ROOTGRID_RUNTIME_DIR:-\${ROOTGRID_INSTALL_DIR:-$ROOTGRID_HOME_DIR}}"
ROOTGRID_INSTALL_DIR="\${ROOTGRID_INSTALL_DIR:-$ROOTGRID_RUNTIME_DIR}"
ROOTGRID_CODEX_PREFIX="$ROOTGRID_RUNTIME_DIR/tools/codex/npm-global"
ROOTGRID_CODEX_BIN="$ROOTGRID_CODEX_PREFIX/bin/codex"
ROOTGRID_CODE_SERVER_HOME="$ROOTGRID_RUNTIME_DIR/tools/code-server/home"
ROOTGRID_CODE_SERVER_BIN="$ROOTGRID_CODE_SERVER_HOME/.local/bin/code-server"
NODE_BIN="\${NODE_BIN:-node}"
TMP_DIR="$(mktemp -d "\${TMPDIR:-/tmp}/rootgrid-install.XXXXXX")"
ARCHIVE_PATH="$TMP_DIR/rootgrid.tgz"
EXTRACT_DIR="$TMP_DIR/rootgrid"

export ROOTGRID_HOME_DIR ROOTGRID_RUNTIME_DIR ROOTGRID_INSTALL_DIR ROOTGRID_CODEX_BIN ROOTGRID_CODE_SERVER_BIN

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "rootgrid runner install requires '$1'" >&2
    exit 1
  fi
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

prompt_yes_no() {
  local question="$1"
  local default_answer="$2"
  local reply=""

  if [ -r /dev/tty ]; then
    if [ "$default_answer" = "1" ]; then
      printf "%s [Y/n]: " "$question" > /dev/tty
    else
      printf "%s [y/N]: " "$question" > /dev/tty
    fi
    read -r reply < /dev/tty || reply=""
  fi

  reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
  if [ -z "$reply" ]; then
    [ "$default_answer" = "1" ]
    return
  fi
  case "$reply" in
    y|yes) return 0 ;;
    n|no) return 1 ;;
  esac
  [ "$default_answer" = "1" ]
}

ensure_optional_tool() {
  local name="$1"
  local version_cmd="$2"
  local install_question="$3"
  local install_cmd="$4"
  local docs_url="$5"
  local continue_question="$6"

  if eval "$version_cmd" >/dev/null 2>&1; then
    local version_line
    version_line="$(eval "$version_cmd" 2>/dev/null | head -n 1 || true)"
    if [ -n "$version_line" ]; then
      echo "[ok] $name: $version_line"
    else
      echo "[ok] $name: installed"
    fi
    return 0
  fi

  echo
  echo "[!] $name was not found in Rootgrid managed tools."
  [ -n "$docs_url" ] && echo "    Docs: $docs_url"

  local install_choice="\${ROOTGRID_AUTO_INSTALL_OPTIONAL_TOOLS:-}"
  if [ "$name" = "Codex" ] && [ -n "\${ROOTGRID_INSTALL_CODEX:-}" ]; then
    install_choice="$ROOTGRID_INSTALL_CODEX"
  fi
  if [ "$name" = "code-server" ] && [ -n "\${ROOTGRID_INSTALL_CODE_SERVER:-}" ]; then
    install_choice="$ROOTGRID_INSTALL_CODE_SERVER"
  fi

  if [ "$install_choice" = "1" ] || [ "$install_choice" = "true" ] || [ "$install_choice" = "yes" ]; then
    :
  elif [ "$install_choice" = "0" ] || [ "$install_choice" = "false" ] || [ "$install_choice" = "no" ]; then
    if [ -n "$continue_question" ]; then
      echo
      echo "[!] $name will not be installed."
      return 0
    fi
    return 1
  else
    if ! prompt_yes_no "$install_question" 1; then
      if [ -n "$continue_question" ]; then
        echo
        echo "[!] $name will not be installed."
        if ! prompt_yes_no "$continue_question" 0; then
          exit 1
        fi
        return 0
      fi
      return 1
    fi
  fi

  echo
  echo "Installing $name…"
  if ! sh -lc "$install_cmd"; then
    echo
    echo "[!] $name install command failed."
  fi

  if eval "$version_cmd" >/dev/null 2>&1; then
    local version_line
    version_line="$(eval "$version_cmd" 2>/dev/null | head -n 1 || true)"
    if [ -n "$version_line" ]; then
      echo "[ok] $name: $version_line"
    else
      echo "[ok] $name: installed"
    fi
    return 0
  fi

  echo
  echo "[!] $name is still not available in Rootgrid managed tools."
  if [ -n "$continue_question" ]; then
    if ! prompt_yes_no "$continue_question" 0; then
      exit 1
    fi
    return 0
  fi
  return 1
}

${buildSystemBubblewrapInstallShellFunction()}

need_cmd curl
need_cmd tar
need_cmd "$NODE_BIN"

if [ -f "$ROOTGRID_HOME_DIR/config.json" ] && [ "\${ROOTGRID_FORCE:-0}" != "1" ]; then
  echo "Refusing to overwrite existing config: $ROOTGRID_HOME_DIR/config.json" >&2
  echo "Set ROOTGRID_FORCE=1 to replace it." >&2
  exit 1
fi

mkdir -p "$EXTRACT_DIR" "$ROOTGRID_HOME_DIR" "$ROOTGRID_RUNTIME_DIR"
curl -fsSL "$ROOTGRID_BUNDLE_URL" -o "$ARCHIVE_PATH"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"

if has_cmd npm; then
  ensure_optional_tool \
    "Codex" \
    "\"$ROOTGRID_CODEX_BIN\" --version" \
    "Install managed Codex now into Rootgrid runtime?" \
    "mkdir -p \"$ROOTGRID_CODEX_PREFIX\" && npm install --global --prefix \"$ROOTGRID_CODEX_PREFIX\" @openai/codex" \
    "https://developers.openai.com/codex/cli" \
    "Continue runner install without managed Codex?"
else
  echo
  echo "[!] npm was not found in PATH, so managed Codex cannot be auto-installed."
  echo "    Install Codex manually: npm install --global --prefix \"$ROOTGRID_CODEX_PREFIX\" @openai/codex"
  if [ ! -x "$ROOTGRID_CODEX_BIN" ]; then
    if ! prompt_yes_no "Continue runner install without managed Codex?" 0; then
      exit 1
    fi
  fi
fi

if [ -x "$ROOTGRID_CODEX_BIN" ]; then
  rootgrid_install_system_bubblewrap
fi

ensure_optional_tool \
  "code-server" \
  "\"$ROOTGRID_CODE_SERVER_BIN\" --version" \
  "Install managed code-server now into Rootgrid runtime?" \
  "mkdir -p \"$ROOTGRID_CODE_SERVER_HOME\" \"$ROOTGRID_CODE_SERVER_HOME/.local/bin\" && HOME=\"$ROOTGRID_CODE_SERVER_HOME\" XDG_CONFIG_HOME=\"$ROOTGRID_CODE_SERVER_HOME/.config\" XDG_CACHE_HOME=\"$ROOTGRID_CODE_SERVER_HOME/.cache\" XDG_DATA_HOME=\"$ROOTGRID_CODE_SERVER_HOME/.local/share\" PATH=\"$ROOTGRID_CODE_SERVER_HOME/.local/bin:$PATH\" sh -lc 'curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone'" \
  "https://coder.com/docs/code-server/latest/install" \
  "Continue runner install without managed code-server? (VS Code web viewer will be unavailable)"

RUNNER_MACHINE_NAME="\${ROOTGRID_MACHINE_NAME:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo runner)}"
RUNNER_MACHINE_ID="\${ROOTGRID_MACHINE_ID:-$("$NODE_BIN" -e "console.log(require('node:crypto').randomUUID())")}"

"$NODE_BIN" - "$ROOTGRID_HOME_DIR/config.json" "$RUNNER_MACHINE_ID" "$RUNNER_MACHINE_NAME" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const [configPath, machineId, machineName] = process.argv.slice(2)
const config = {
  version: ${Number(configVersion) || 1},
  retentionDays: 30,
  notifications: {
    sseToasts: 'if-not-visible',
    webPush: 'if-not-visible',
    sound: false
  },
  debug: {
    codexRawCapture: {
      enabled: false,
      dir: null
    }
  },
  autostart: {
    enabled: false,
    method: null
  },
  runner: {
    enabled: true,
    machineId,
    machineName,
    upgrade: {
      enabled: true,
      keepReleases: 3
    }
  },
  host: {
    enabled: false,
    listen: { host: '127.0.0.1', port: 7337 },
    publicUrl: null,
    trustProxy: false,
    auth: {
      clientToken: crypto.randomBytes(32).toString('hex'),
      runnerToken: ${jsonString(safeRunnerToken)}
    }
  },
  upstream: {
    enabled: true,
    url: ${jsonString(safeBaseUrl)},
    runnerToken: ${jsonString(safeRunnerToken)}
  }
}

fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 })
NODE

echo "Installing Rootgrid runner $ROOTGRID_VERSION ($ROOTGRID_RELEASE_ID) into $ROOTGRID_RUNTIME_DIR ..."
"$NODE_BIN" "$EXTRACT_DIR/src/cli.js" install-service
echo
echo "Rootgrid runner installed."
echo "Status: systemctl --user status rootgrid  # Linux/WSL"
echo "Logs:   journalctl --user -u rootgrid -f  # Linux/WSL"
`
}

export function createRunnerInstallManager({
  config,
  releaseBundles,
  ttlMs = 15 * 60 * 1000,
  now = () => Date.now()
}) {
  const tokens = new Map()

  function purgeExpired() {
    const current = now()
    for (const [token, entry] of tokens.entries()) {
      if (Number(entry?.expiresAtMs ?? 0) <= current) tokens.delete(token)
    }
  }

  async function createBootstrap(req) {
    purgeExpired()
    const installToken = crypto.randomBytes(24).toString('base64url')
    const expiresAtMs = now() + Math.max(60_000, Number(ttlMs) || (15 * 60 * 1000))
    tokens.set(installToken, { expiresAtMs })
    const baseUrl = buildExternalBaseUrl(req, {
      publicUrl: config?.host?.publicUrl ?? null,
      trustProxy: config?.host?.trustProxy ?? false
    })
    const bundle = await releaseBundles.getBundle()
    const installUrl = `${baseUrl}/api/install/runner.sh?installToken=${encodeURIComponent(installToken)}`
    return {
      installToken,
      expiresAtMs,
      baseUrl,
      installUrl,
      installCommand: `curl -fsSL ${shellQuote(installUrl)} | bash`,
      version: trimText(bundle?.version) ?? '0.0.0',
      releaseId: trimText(bundle?.releaseId)
    }
  }

  function getValidToken(token) {
    purgeExpired()
    const safeToken = trimText(token)
    if (!safeToken) return null
    const entry = tokens.get(safeToken)
    if (!entry) return null
    return {
      token: safeToken,
      expiresAtMs: entry.expiresAtMs
    }
  }

  async function renderInstallScript(req, token) {
    const valid = getValidToken(token)
    if (!valid) return null
    const baseUrl = buildExternalBaseUrl(req, {
      publicUrl: config?.host?.publicUrl ?? null,
      trustProxy: config?.host?.trustProxy ?? false
    })
    const bundleMeta = releaseBundles?.getBundleMetadata?.() ?? {}
    return buildRunnerInstallScript({
      baseUrl,
      installToken: valid.token,
      runnerToken: config?.host?.auth?.runnerToken,
      version: trimText(bundleMeta.version) ?? '0.0.0',
      releaseId: trimText(bundleMeta.releaseId),
      configVersion: config?.version ?? 1
    })
  }

  async function getBundleForToken(token) {
    const valid = getValidToken(token)
    if (!valid) return null
    return await releaseBundles.getBundle()
  }

  return {
    createBootstrap,
    renderInstallScript,
    getBundleForToken
  }
}
