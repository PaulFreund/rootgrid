#!/usr/bin/env bash
set -euo pipefail

ROOTGRID_GITHUB_REPO="${ROOTGRID_GITHUB_REPO:-}"
ROOTGRID_GITHUB_BRANCH="${ROOTGRID_GITHUB_BRANCH:-main}"
ROOTGRID_GITHUB_TOKEN="${ROOTGRID_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
ROOTGRID_GITHUB_API="${ROOTGRID_GITHUB_API:-https://api.github.com}"
ROOTGRID_GITHUB_ASSET_NAME="${ROOTGRID_GITHUB_ASSET_NAME:-rootgrid-managed-release.tgz}"
ROOTGRID_HOST_KEEP_RELEASES="${ROOTGRID_HOST_KEEP_RELEASES:-3}"
ROOTGRID_BOOTSTRAP_FORCE="${ROOTGRID_BOOTSTRAP_FORCE:-0}"
ROOTGRID_HOME_DIR="${ROOTGRID_HOME_DIR:-$HOME/.rootgrid}"
ROOTGRID_RUNTIME_DIR="${ROOTGRID_RUNTIME_DIR:-${ROOTGRID_INSTALL_DIR:-$ROOTGRID_HOME_DIR}}"
ROOTGRID_INSTALL_DIR="${ROOTGRID_INSTALL_DIR:-$ROOTGRID_RUNTIME_DIR}"
ROOTGRID_CONFIG_PATH="${ROOTGRID_CONFIG_PATH:-$ROOTGRID_HOME_DIR/config.json}"
NODE_BIN="${NODE_BIN:-node}"
export ROOTGRID_HOME_DIR ROOTGRID_RUNTIME_DIR ROOTGRID_INSTALL_DIR ROOTGRID_CONFIG_PATH
CURRENT_CLI="$ROOTGRID_RUNTIME_DIR/current/src/cli.js"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rootgrid-container.XXXXXX")"
ARCHIVE_PATH="$TMP_DIR/$ROOTGRID_GITHUB_ASSET_NAME"
PENDING_DIR="$ROOTGRID_RUNTIME_DIR/releases/.pending-$(date +%s)-$$"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "rootgrid container bootstrap requires '$1'" >&2
    exit 1
  fi
}

curl_json() {
  local url="$1"
  if [ -n "$ROOTGRID_GITHUB_TOKEN" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $ROOTGRID_GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: rootgrid-container" \
      "$url"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: rootgrid-container" \
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
      -H "User-Agent: rootgrid-container" \
      "$url" \
      -o "$out"
  else
    curl -fsSL \
      -H "Accept: application/octet-stream" \
      -H "User-Agent: rootgrid-container" \
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
      -H "User-Agent: rootgrid-container" \
      "$url"
  else
    curl -fsSL \
      -H "Accept: application/octet-stream" \
      -H "User-Agent: rootgrid-container" \
      "$url"
  fi
}

bootstrap_release() {
  if [ -z "$ROOTGRID_GITHUB_REPO" ]; then
    echo "Set ROOTGRID_GITHUB_REPO=OWNER/REPO before starting Rootgrid." >&2
    exit 1
  fi

  local release_tag
  release_tag="$("$NODE_BIN" -e '
const raw = String(process.argv[1] ?? "main").trim();
const branch = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "main";
process.stdout.write(`branch-${branch}`);
' "$ROOTGRID_GITHUB_BRANCH")"

  echo "[startup] Downloading Rootgrid release ${release_tag} from ${ROOTGRID_GITHUB_REPO}..."
  local release_json
  release_json="$(curl_json "$ROOTGRID_GITHUB_API/repos/$ROOTGRID_GITHUB_REPO/releases/tags/$release_tag")"

  local asset_api_url
  asset_api_url="$("$NODE_BIN" - "$release_json" "$ROOTGRID_GITHUB_ASSET_NAME" <<'NODE'
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

  local checksum_api_url
  checksum_api_url="$("$NODE_BIN" - "$release_json" "$ROOTGRID_GITHUB_ASSET_NAME" <<'NODE'
const [raw, assetName] = process.argv.slice(2)
const release = JSON.parse(raw)
const assets = Array.isArray(release?.assets) ? release.assets : []
const asset = assets.find((entry) => String(entry?.name ?? '') === `${assetName}.sha256`)
process.stdout.write(String(asset?.url ?? ''))
NODE
)"

  mkdir -p "$ROOTGRID_RUNTIME_DIR/releases"
  curl_asset "$asset_api_url" "$ARCHIVE_PATH"

  if [ -n "$checksum_api_url" ]; then
    local checksum_text
    checksum_text="$(curl_asset_stdout "$checksum_api_url")"
    "$NODE_BIN" - "$ARCHIVE_PATH" "$checksum_text" "$ROOTGRID_GITHUB_ASSET_NAME" <<'NODE'
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

  rm -rf "$PENDING_DIR"
  mkdir -p "$PENDING_DIR"
  tar -xzf "$ARCHIVE_PATH" -C "$PENDING_DIR"

  local release_id
  release_id="$("$NODE_BIN" - "$PENDING_DIR/release.json" <<'NODE'
const fs = require('node:fs')
const manifestPath = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const releaseId = String(manifest?.releaseId ?? '').trim()
if (!releaseId) {
  console.error('release manifest missing releaseId')
  process.exit(1)
}
process.stdout.write(releaseId)
NODE
)"

  local release_dir="$ROOTGRID_RUNTIME_DIR/releases/$release_id"
  rm -rf "$release_dir"
  mv "$PENDING_DIR" "$release_dir"

  ln -sfn "$release_dir" "$ROOTGRID_RUNTIME_DIR/current.tmp"
  mv -Tf "$ROOTGRID_RUNTIME_DIR/current.tmp" "$ROOTGRID_RUNTIME_DIR/current"

  "$NODE_BIN" - "$ROOTGRID_RUNTIME_DIR" "$ROOTGRID_HOST_KEEP_RELEASES" "$release_id" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const [rootgridDir, keepRaw, currentReleaseId] = process.argv.slice(2)
const releasesDir = path.join(rootgridDir, 'releases')
const keep = Math.max(1, Number.parseInt(String(keepRaw ?? '3'), 10) || 3)

let rows = []
for (const entry of fs.readdirSync(releasesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const releaseId = String(entry.name ?? '').trim()
  if (!releaseId || releaseId === currentReleaseId || releaseId.startsWith('.pending-')) continue
  const releaseDir = path.join(releasesDir, releaseId)
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'release.json'), 'utf8'))
    rows.push({
      releaseDir,
      createdAtMs: Number(manifest?.createdAtMs ?? 0) || 0
    })
  } catch {}
}

rows.sort((a, b) => b.createdAtMs - a.createdAtMs)
for (const row of rows.slice(Math.max(0, keep - 1))) {
  try { fs.rmSync(row.releaseDir, { recursive: true, force: true }) } catch {}
}
NODE
}

need_cmd curl
need_cmd tar
need_cmd "$NODE_BIN"

mkdir -p "$ROOTGRID_HOME_DIR" "$ROOTGRID_RUNTIME_DIR"

if [ ! -f "$ROOTGRID_CONFIG_PATH" ]; then
  echo "[startup] Missing Rootgrid config: $ROOTGRID_CONFIG_PATH" >&2
  echo "[startup] Mount your Rootgrid home or provide config.json before starting the container." >&2
  exit 1
fi

if [ "$ROOTGRID_BOOTSTRAP_FORCE" = "1" ] || [ ! -f "$CURRENT_CLI" ]; then
  bootstrap_release
fi

if [ ! -f "$CURRENT_CLI" ]; then
  echo "[startup] Rootgrid runtime is missing: $CURRENT_CLI" >&2
  exit 1
fi

exec "$NODE_BIN" "$CURRENT_CLI"
