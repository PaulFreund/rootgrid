#!/usr/bin/env bash
set -euo pipefail

ROOTGRID_GITHUB_REPO="${ROOTGRID_GITHUB_REPO:-}"
ROOTGRID_GITHUB_BRANCH="${ROOTGRID_GITHUB_BRANCH:-main}"
ROOTGRID_GITHUB_TOKEN="${ROOTGRID_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
ROOTGRID_GITHUB_API="${ROOTGRID_GITHUB_API:-https://api.github.com}"
ROOTGRID_GITHUB_ASSET_NAME="${ROOTGRID_GITHUB_ASSET_NAME:-rootgrid-managed-release.tgz}"
ROOTGRID_HOST_KEEP_RELEASES="${ROOTGRID_HOST_KEEP_RELEASES:-3}"
ROOTGRID_HOST_RESTART_COMMAND="${ROOTGRID_HOST_RESTART_COMMAND:-}"
ROOTGRID_ENABLE_HOST_SELF_UPDATE="${ROOTGRID_ENABLE_HOST_SELF_UPDATE:-1}"
ROOTGRID_DIR="${ROOTGRID_DIR:-$HOME/.rootgrid}"
NODE_BIN="${NODE_BIN:-node}"
CONFIG_PATH="$ROOTGRID_DIR/config.json"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rootgrid-host-install.XXXXXX")"
ARCHIVE_PATH="$TMP_DIR/$ROOTGRID_GITHUB_ASSET_NAME"
EXTRACT_DIR="$TMP_DIR/rootgrid"
CURRENT_CLI="$ROOTGRID_DIR/current/src/cli.js"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "rootgrid host install requires '$1'" >&2
    exit 1
  fi
}

curl_json() {
  local url="$1"
  if [ -n "$ROOTGRID_GITHUB_TOKEN" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $ROOTGRID_GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: rootgrid-install" \
      "$url"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: rootgrid-install" \
      "$url"
  fi
}

curl_asset() {
  local url="$1"
  local out="$2"
  if [ -n "$ROOTGRID_GITHUB_TOKEN" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $ROOTGRID_GITHUB_TOKEN" \
      -H "Accept: application/octet-stream" \
      -H "User-Agent: rootgrid-install" \
      "$url" \
      -o "$out"
  else
    curl -fsSL \
      -H "Accept: application/octet-stream" \
      -H "User-Agent: rootgrid-install" \
      "$url" \
      -o "$out"
  fi
}

curl_asset_stdout() {
  local url="$1"
  if [ -n "$ROOTGRID_GITHUB_TOKEN" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $ROOTGRID_GITHUB_TOKEN" \
      -H "Accept: application/octet-stream" \
      -H "User-Agent: rootgrid-install" \
      "$url"
  else
    curl -fsSL \
      -H "Accept: application/octet-stream" \
      -H "User-Agent: rootgrid-install" \
      "$url"
  fi
}

need_cmd curl
need_cmd tar
need_cmd "$NODE_BIN"

if [ -z "$ROOTGRID_GITHUB_REPO" ]; then
  echo "Set ROOTGRID_GITHUB_REPO=OWNER/REPO before running this installer." >&2
  exit 1
fi

RELEASE_TAG="$("$NODE_BIN" -e '
const raw = String(process.argv[1] ?? "main").trim();
const branch = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "main";
process.stdout.write(`branch-${branch}`);
' "$ROOTGRID_GITHUB_BRANCH")"

RELEASE_JSON="$(curl_json "$ROOTGRID_GITHUB_API/repos/$ROOTGRID_GITHUB_REPO/releases/tags/$RELEASE_TAG")"

ASSET_API_URL="$("$NODE_BIN" - "$RELEASE_JSON" "$ROOTGRID_GITHUB_ASSET_NAME" <<'NODE'
const [raw, assetName] = process.argv.slice(2)
const release = JSON.parse(raw)
const assets = Array.isArray(release?.assets) ? release.assets : []
const asset = assets.find((entry) => String(entry?.name ?? '') === assetName)
if (!asset?.url) {
  console.error(`missing release asset: ${assetName}`)
  process.exit(1)
}
process.stdout.write(String(asset.url))
NODE
)"

CHECKSUM_API_URL="$("$NODE_BIN" - "$RELEASE_JSON" "$ROOTGRID_GITHUB_ASSET_NAME" <<'NODE'
const [raw, assetName] = process.argv.slice(2)
const release = JSON.parse(raw)
const assets = Array.isArray(release?.assets) ? release.assets : []
const asset = assets.find((entry) => String(entry?.name ?? '') === `${assetName}.sha256`)
process.stdout.write(String(asset?.url ?? ''))
NODE
)"

mkdir -p "$EXTRACT_DIR" "$ROOTGRID_DIR"
curl_asset "$ASSET_API_URL" "$ARCHIVE_PATH"

if [ -n "$CHECKSUM_API_URL" ]; then
  CHECKSUM_TEXT="$(curl_asset_stdout "$CHECKSUM_API_URL")"
  "$NODE_BIN" - "$ARCHIVE_PATH" "$CHECKSUM_TEXT" "$ROOTGRID_GITHUB_ASSET_NAME" <<'NODE'
const crypto = require('node:crypto')
const fs = require('node:fs')

const [archivePath, checksumText, assetName] = process.argv.slice(2)
const preferred = String(checksumText ?? '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .find((line) => line.includes(assetName))
  || String(checksumText ?? '').trim()
const match = preferred.match(/([a-fA-F0-9]{64})/)
if (!match) process.exit(0)
const expected = match[1].toLowerCase()
const hash = crypto.createHash('sha256')
hash.update(fs.readFileSync(archivePath))
const actual = hash.digest('hex')
if (actual !== expected) {
  console.error('downloaded bundle checksum mismatch')
  process.exit(1)
}
NODE
fi

tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"

"$NODE_BIN" "$EXTRACT_DIR/src/cli.js" update-local

if [ ! -f "$CONFIG_PATH" ]; then
  "$NODE_BIN" "$CURRENT_CLI" setup
fi

if [ "$ROOTGRID_ENABLE_HOST_SELF_UPDATE" != "0" ] && [ -f "$CONFIG_PATH" ]; then
  "$NODE_BIN" - "$CONFIG_PATH" "$ROOTGRID_GITHUB_REPO" "$ROOTGRID_GITHUB_BRANCH" "$ROOTGRID_GITHUB_TOKEN" "$ROOTGRID_GITHUB_ASSET_NAME" "$ROOTGRID_HOST_KEEP_RELEASES" "$ROOTGRID_HOST_RESTART_COMMAND" <<'NODE'
const fs = require('node:fs')

const [configPath, repo, branch, accessToken, assetName, keepReleasesRaw, restartCommand] = process.argv.slice(2)
const keepReleases = Number.parseInt(String(keepReleasesRaw ?? '3'), 10)
const raw = fs.readFileSync(configPath, 'utf8')
const config = JSON.parse(raw)

config.host = config.host ?? {}
config.host.selfUpdate = {
  ...(config.host.selfUpdate ?? {}),
  enabled: true,
  repo,
  branch: branch || 'main',
  accessToken: accessToken || null,
  assetName: assetName || 'rootgrid-managed-release.tgz',
  keepReleases: Number.isFinite(keepReleases) && keepReleases > 0 ? keepReleases : 3,
  restartCommand: restartCommand || null
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
NODE
fi

"$NODE_BIN" "$CURRENT_CLI" install-service

echo
echo "Rootgrid host install/upgrade complete."
echo "Managed runtime: $ROOTGRID_DIR/current"
