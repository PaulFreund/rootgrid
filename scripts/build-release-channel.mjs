#!/usr/bin/env node
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_GITHUB_RELEASE_ASSET_NAME,
  buildGitHubReleaseChannelTag,
  buildGitHubReleaseMetadataAssetName
} from '../src/lib/githubReleaseChannel.js'
import {
  createManagedReleaseBundle,
  getCurrentPackageRoot
} from '../src/lib/managedRelease.js'
import { ROOTGRID_VERSION } from '../src/lib/rootgridVersion.js'

const branch = String(process.env.GITHUB_REF_NAME ?? process.argv[2] ?? 'main').trim() || 'main'
const sourceRoot = getCurrentPackageRoot()
const outDir = join(sourceRoot, '.release-channel')

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true, mode: 0o700 })

const bundle = await createManagedReleaseBundle({
  sourceRoot,
  version: ROOTGRID_VERSION,
  outDir,
  source: `github:${branch}`
})

const assetPath = join(outDir, DEFAULT_GITHUB_RELEASE_ASSET_NAME)
const metadataPath = join(outDir, buildGitHubReleaseMetadataAssetName(DEFAULT_GITHUB_RELEASE_ASSET_NAME))
await rename(bundle.bundlePath, assetPath)
await writeFile(
  `${assetPath}.sha256`,
  `${bundle.sha256}  ${DEFAULT_GITHUB_RELEASE_ASSET_NAME}\n`,
  { encoding: 'utf8', mode: 0o600 }
)
await writeFile(metadataPath, `${JSON.stringify({
  releaseId: bundle.releaseId,
  version: bundle.version,
  sha256: bundle.sha256,
  assetName: DEFAULT_GITHUB_RELEASE_ASSET_NAME,
  source: bundle.manifest?.source ?? null,
  createdAtMs: bundle.manifest?.createdAtMs ?? null
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

const releaseTag = buildGitHubReleaseChannelTag(branch)
const releaseName = `Branch channel: ${branch}`
const output = String(process.env.GITHUB_OUTPUT ?? '').trim()
if (output) {
  await writeFile(output, [
    `release_tag=${releaseTag}`,
    `release_name=${releaseName}`,
    `asset_path=${assetPath}`,
    `asset_sha_path=${assetPath}.sha256`,
    `asset_meta_path=${metadataPath}`
  ].join('\n') + '\n', { encoding: 'utf8' })
}

console.log(`Prepared ${DEFAULT_GITHUB_RELEASE_ASSET_NAME} for ${releaseTag}`)
