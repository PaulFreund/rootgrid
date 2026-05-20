import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildGitHubReleaseChannelTag,
  buildGitHubReleaseMetadataAssetName,
  downloadGitHubReleaseBundleToFile,
  extractGitHubAccessTokenFromRepoSpec,
  fetchGitHubReleaseChannelInfo,
  parseGitHubRepositorySpec,
  sanitizeGitHubRepoForDisplay
} from '../src/lib/githubReleaseChannel.js'

test('GitHub release channel helpers normalize repo specs and branch tags', () => {
  assert.deepEqual(parseGitHubRepositorySpec('org/rootgrid'), {
    owner: 'org',
    repo: 'rootgrid',
    display: 'org/rootgrid'
  })
  assert.deepEqual(parseGitHubRepositorySpec('https://github.com/org/rootgrid.git'), {
    owner: 'org',
    repo: 'rootgrid',
    display: 'org/rootgrid'
  })
  assert.equal(extractGitHubAccessTokenFromRepoSpec('https://token@github.com/org/rootgrid.git'), 'token')
  assert.equal(sanitizeGitHubRepoForDisplay('https://token@github.com/org/rootgrid.git'), 'org/rootgrid')
  assert.equal(buildGitHubReleaseChannelTag('feature/release'), 'branch-feature-release')
})

test('downloadGitHubReleaseBundleToFile downloads the branch release asset and checksum', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-gh-release-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })
  const outPath = join(base, 'rootgrid-managed-release.tgz')
  const calls = []
  const bundleBody = Buffer.from('bundle-data')

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })

    if (String(url).endsWith('/releases/tags/branch-main')) {
      return {
        ok: true,
        async json() {
          return {
            name: 'Branch channel: main',
            assets: [
              {
                name: 'rootgrid-managed-release.tgz',
                url: 'https://api.github.com/assets/1',
                digest: null
              },
              {
                name: 'rootgrid-managed-release.tgz.sha256',
                url: 'https://api.github.com/assets/2'
              }
            ]
          }
        }
      }
    }

    if (String(url) === 'https://api.github.com/assets/1') {
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bundleBody)
            controller.close()
          }
        })
      }
    }

    if (String(url) === 'https://api.github.com/assets/2') {
      return {
        ok: true,
        async text() {
          return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  rootgrid-managed-release.tgz\n'
        }
      }
    }

    throw new Error(`unexpected URL: ${url}`)
  }

  const result = await downloadGitHubReleaseBundleToFile({
    repoSpec: 'org/rootgrid',
    branch: 'main',
    accessToken: 'github-token',
    outPath,
    fetchImpl
  })

  assert.equal(result.repo, 'org/rootgrid')
  assert.equal(result.tag, 'branch-main')
  assert.equal(result.expectedSha256, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(await readFile(outPath, 'utf8'), 'bundle-data')
  assert.match(String(calls[0]?.url), /\/releases\/tags\/branch-main$/)
  assert.equal(calls[0]?.init?.headers?.Authorization, 'Bearer github-token')
})

test('fetchGitHubReleaseChannelInfo reads managed release metadata when available', async () => {
  const metadataAssetName = buildGitHubReleaseMetadataAssetName('rootgrid-managed-release.tgz')
  const calls = []

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })

    if (String(url).endsWith('/releases/tags/branch-main')) {
      return {
        ok: true,
        async json() {
          return {
            id: 42,
            name: 'Branch channel: main',
            published_at: '2025-01-02T03:04:05.000Z',
            assets: [
              {
                name: 'rootgrid-managed-release.tgz',
                size: 1234,
                url: 'https://api.github.com/assets/1',
                digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
              },
              {
                name: metadataAssetName,
                url: 'https://api.github.com/assets/3'
              }
            ]
          }
        }
      }
    }

    if (String(url) === 'https://api.github.com/assets/3') {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            releaseId: 'rootgrid-1.2.3-test',
            version: '1.2.3+gabcdef123456',
            sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            assetName: 'rootgrid-managed-release.tgz',
            source: 'github:main',
            createdAtMs: 1735787045000
          })
        }
      }
    }

    throw new Error(`unexpected URL: ${url}`)
  }

  const result = await fetchGitHubReleaseChannelInfo({
    repoSpec: 'org/rootgrid',
    branch: 'main',
    accessToken: 'github-token',
    fetchImpl
  })

  assert.equal(result.repo, 'org/rootgrid')
  assert.equal(result.channelReleaseId, 42)
  assert.equal(result.releaseName, 'Branch channel: main')
  assert.equal(result.version, '1.2.3+gabcdef123456')
  assert.equal(result.releaseId, 'rootgrid-1.2.3-test')
  assert.equal(result.bundleSha256, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')
  assert.equal(result.expectedSha256, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(result.metadataAssetName, metadataAssetName)
  assert.equal(result.sizeBytes, 1234)
  assert.equal(result.source, 'github:main')
  assert.equal(result.createdAtMs, 1735787045000)
  assert.equal(result.publishedAtMs, Date.parse('2025-01-02T03:04:05.000Z'))
  assert.equal(calls[0]?.init?.headers?.Authorization, 'Bearer github-token')
})
