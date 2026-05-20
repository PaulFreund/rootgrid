import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const DEFAULT_GITHUB_RELEASE_ASSET_NAME = 'rootgrid-managed-release.tgz'
export const GITHUB_RELEASE_TAG_PREFIX = 'branch-'
export const GITHUB_RELEASE_METADATA_SUFFIX = '.metadata.json'

function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function sanitizeTagComponent(value) {
  const text = String(value ?? '').trim()
  const normalized = text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'main'
}

function buildGitHubHeaders({ accessToken = null, accept = 'application/vnd.github+json' } = {}) {
  const headers = {
    Accept: accept,
    'User-Agent': 'rootgrid'
  }
  const token = trimText(accessToken)
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function readJsonResponse(res) {
  return await res.json().catch(() => null)
}

async function readTextResponse(res) {
  return await res.text().catch(() => '')
}

async function fetchGitHubJson(url, { accessToken = null, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: buildGitHubHeaders({ accessToken })
  })
  if (res.ok) return await readJsonResponse(res)

  const body = await readJsonResponse(res)
  const message = trimText(body?.message) ?? `GitHub API request failed (${res.status})`
  const err = new Error(message)
  err.statusCode = Number(res.status) || 500
  throw err
}

async function downloadGitHubAssetToFile(url, outPath, {
  accessToken = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const res = await fetchImpl(url, {
    headers: buildGitHubHeaders({
      accessToken,
      accept: 'application/octet-stream'
    })
  })
  if (!res.ok || !res.body) {
    const text = await readTextResponse(res)
    const err = new Error(trimText(text) ?? `GitHub asset download failed (${res.status})`)
    err.statusCode = Number(res.status) || 500
    throw err
  }
  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 })
  const dest = createWriteStream(outPath, { mode: 0o600 })
  await pipeline(Readable.fromWeb(res.body), dest)
}

async function downloadGitHubAssetText(url, {
  accessToken = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const res = await fetchImpl(url, {
    headers: buildGitHubHeaders({
      accessToken,
      accept: 'application/octet-stream'
    })
  })
  if (!res.ok) {
    const text = await readTextResponse(res)
    const err = new Error(trimText(text) ?? `GitHub asset download failed (${res.status})`)
    err.statusCode = Number(res.status) || 500
    throw err
  }
  return await readTextResponse(res)
}

function parseSha256Digest(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const normalized = text.startsWith('sha256:') ? text.slice('sha256:'.length) : text
  return /^[a-f0-9]{64}$/i.test(normalized) ? normalized.toLowerCase() : null
}

function parseChecksumText(text, assetName) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return null
  const preferred = lines.find((line) => line.includes(assetName)) ?? lines[0]
  const match = preferred.match(/([a-fA-F0-9]{64})/)
  return match ? match[1].toLowerCase() : null
}

function normalizeTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value)
  const text = trimText(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseReleaseMetadataText(text, assetName) {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const version = trimText(parsed?.version)
  const releaseId = trimText(parsed?.releaseId)
  const bundleSha256 = parseSha256Digest(parsed?.sha256 ?? parsed?.bundleSha256)
  if (!version && !releaseId && !bundleSha256) return null

  return {
    version,
    releaseId,
    bundleSha256,
    assetName: trimText(parsed?.assetName) ?? trimText(assetName),
    source: trimText(parsed?.source),
    createdAtMs: normalizeTimestampMs(parsed?.createdAtMs),
    publishedAtMs: normalizeTimestampMs(parsed?.publishedAtMs)
  }
}

export function buildGitHubReleaseChannelTag(branch = 'main') {
  return `${GITHUB_RELEASE_TAG_PREFIX}${sanitizeTagComponent(branch)}`
}

export function buildGitHubReleaseMetadataAssetName(assetName = DEFAULT_GITHUB_RELEASE_ASSET_NAME) {
  const safeAssetName = trimText(assetName) ?? DEFAULT_GITHUB_RELEASE_ASSET_NAME
  return `${safeAssetName}${GITHUB_RELEASE_METADATA_SUFFIX}`
}

export function extractGitHubAccessTokenFromRepoSpec(value) {
  const raw = trimText(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!/github\.com$/i.test(url.hostname)) return null
    return trimText(url.password) ?? trimText(url.username)
  } catch {
    return null
  }
}

export function parseGitHubRepositorySpec(value) {
  const raw = trimText(value)
  if (!raw) return null

  const plain = raw.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)
  if (plain) {
    return {
      owner: plain[1],
      repo: plain[2],
      display: `${plain[1]}/${plain[2]}`
    }
  }

  const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (ssh) {
    return {
      owner: ssh[1],
      repo: ssh[2],
      display: `${ssh[1]}/${ssh[2]}`
    }
  }

  try {
    const url = new URL(raw)
    if (!/github\.com$/i.test(url.hostname)) return null
    const parts = url.pathname.replace(/\/+$/, '').replace(/^\/+/, '').split('/')
    if (parts.length < 2) return null
    const owner = trimText(parts[0])
    const repo = trimText(parts[1]?.replace(/\.git$/i, ''))
    if (!owner || !repo) return null
    return {
      owner,
      repo,
      display: `${owner}/${repo}`
    }
  } catch {
    return null
  }
}

export function sanitizeGitHubRepoForDisplay(value) {
  const parsed = parseGitHubRepositorySpec(value)
  if (parsed) return parsed.display

  const raw = trimText(value)
  if (!raw) return '—'
  return raw.replace(/\/\/[^/@:\s]+:[^/@\s]+@/g, '//***:***@')
}

export async function fetchGitHubReleaseChannelInfo({
  repoSpec,
  branch = 'main',
  assetName = DEFAULT_GITHUB_RELEASE_ASSET_NAME,
  accessToken = null,
  apiBaseUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch
} = {}) {
  const parsed = parseGitHubRepositorySpec(repoSpec)
  if (!parsed) throw new Error('host self-update repo must be owner/repo or a GitHub repository URL')

  const tag = buildGitHubReleaseChannelTag(branch)
  const release = await fetchGitHubJson(
    `${String(apiBaseUrl).replace(/\/+$/, '')}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/releases/tags/${encodeURIComponent(tag)}`,
    { accessToken, fetchImpl }
  )

  const assets = Array.isArray(release?.assets) ? release.assets : []
  const bundleAsset = assets.find((asset) => String(asset?.name ?? '') === assetName)
  if (!bundleAsset?.url) {
    throw new Error(`GitHub release channel ${tag} does not include asset ${assetName}`)
  }

  let expectedSha256 = parseSha256Digest(bundleAsset?.digest)
  if (!expectedSha256) {
    const checksumAsset = assets.find((asset) => String(asset?.name ?? '') === `${assetName}.sha256`)
    if (checksumAsset?.url) {
      const checksumText = await downloadGitHubAssetText(checksumAsset.url, {
        accessToken,
        fetchImpl
      })
      expectedSha256 = parseChecksumText(checksumText, assetName)
    }
  }

  let metadata = null
  const metadataAssetName = buildGitHubReleaseMetadataAssetName(assetName)
  const metadataAsset = assets.find((asset) => String(asset?.name ?? '') === metadataAssetName)
  if (metadataAsset?.url) {
    try {
      const metadataText = await downloadGitHubAssetText(metadataAsset.url, {
        accessToken,
        fetchImpl
      })
      metadata = parseReleaseMetadataText(metadataText, assetName)
    } catch {
    }
  }

  return {
    repo: parsed.display,
    owner: parsed.owner,
    repository: parsed.repo,
    branch: String(branch ?? '').trim() || 'main',
    tag,
    channelReleaseId: Number.isFinite(Number(release?.id)) ? Number(release.id) : null,
    releaseName: trimText(release?.name) ?? null,
    publishedAtMs: normalizeTimestampMs(release?.published_at ?? release?.created_at),
    assetName,
    metadataAssetName,
    bundleAssetUrl: String(bundleAsset.url),
    sizeBytes: Number.isFinite(Number(bundleAsset?.size)) && Number(bundleAsset.size) > 0 ? Number(bundleAsset.size) : null,
    expectedSha256: expectedSha256
      ?? metadata?.bundleSha256
      ?? null,
    version: trimText(metadata?.version),
    releaseId: trimText(metadata?.releaseId),
    bundleSha256: parseSha256Digest(metadata?.bundleSha256)
      ?? expectedSha256
      ?? null,
    source: trimText(metadata?.source),
    createdAtMs: Number.isFinite(Number(metadata?.createdAtMs)) && Number(metadata.createdAtMs) > 0
      ? Number(metadata.createdAtMs)
      : null
  }
}

export async function downloadGitHubReleaseBundleToFile({
  repoSpec,
  branch = 'main',
  assetName = DEFAULT_GITHUB_RELEASE_ASSET_NAME,
  accessToken = null,
  apiBaseUrl = 'https://api.github.com',
  outPath,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!outPath) throw new Error('outPath is required')

  const info = await fetchGitHubReleaseChannelInfo({
    repoSpec,
    branch,
    assetName,
    accessToken,
    apiBaseUrl,
    fetchImpl
  })

  await downloadGitHubAssetToFile(info.bundleAssetUrl, outPath, {
    accessToken,
    fetchImpl
  })

  const { bundleAssetUrl, ...publicInfo } = info
  return publicInfo
}
