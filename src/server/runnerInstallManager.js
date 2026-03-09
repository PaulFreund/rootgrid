import crypto from 'node:crypto'

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

  const bundleUrl = `${safeBaseUrl}/api/install/runner-bundle?installToken=${encodeURIComponent(safeInstallToken)}`

  return `#!/usr/bin/env bash
set -euo pipefail

ROOTGRID_BASE_URL=${shellQuote(safeBaseUrl)}
ROOTGRID_INSTALL_TOKEN=${shellQuote(safeInstallToken)}
ROOTGRID_BUNDLE_URL=${shellQuote(bundleUrl)}
ROOTGRID_VERSION=${shellQuote(version)}
ROOTGRID_RELEASE_ID=${shellQuote(releaseId)}
ROOTGRID_DIR="\${ROOTGRID_DIR:-$HOME/.rootgrid}"
NODE_BIN="\${NODE_BIN:-node}"
TMP_DIR="$(mktemp -d "\${TMPDIR:-/tmp}/rootgrid-install.XXXXXX")"
ARCHIVE_PATH="$TMP_DIR/rootgrid.tgz"
EXTRACT_DIR="$TMP_DIR/rootgrid"

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

need_cmd curl
need_cmd tar
need_cmd "$NODE_BIN"

if [ -f "$ROOTGRID_DIR/config.json" ] && [ "\${ROOTGRID_FORCE:-0}" != "1" ]; then
  echo "Refusing to overwrite existing config: $ROOTGRID_DIR/config.json" >&2
  echo "Set ROOTGRID_FORCE=1 to replace it." >&2
  exit 1
fi

mkdir -p "$EXTRACT_DIR" "$ROOTGRID_DIR"
curl -fsSL "$ROOTGRID_BUNDLE_URL" -o "$ARCHIVE_PATH"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"

RUNNER_MACHINE_NAME="\${ROOTGRID_MACHINE_NAME:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo runner)}"
RUNNER_MACHINE_ID="\${ROOTGRID_MACHINE_ID:-$("$NODE_BIN" -e "console.log(require('node:crypto').randomUUID())")}"

"$NODE_BIN" - "$ROOTGRID_DIR/config.json" "$RUNNER_MACHINE_ID" "$RUNNER_MACHINE_NAME" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const [configPath, machineId, machineName] = process.argv.slice(2)
const config = {
  version: ${Number(configVersion) || 1},
  retentionDays: 30,
  notifications: {
    sseToasts: 'if-not-visible',
    webPush: 'if-not-visible'
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

echo "Installing Rootgrid runner $ROOTGRID_VERSION ($ROOTGRID_RELEASE_ID) into $ROOTGRID_DIR ..."
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
      version: bundle.version,
      releaseId: bundle.releaseId
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
    const bundle = await releaseBundles.getBundle()
    return buildRunnerInstallScript({
      baseUrl,
      installToken: valid.token,
      runnerToken: config?.host?.auth?.runnerToken,
      version: bundle.version,
      releaseId: bundle.releaseId,
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
