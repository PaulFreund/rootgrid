import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'

import { createManagedReleaseBundle, getCurrentPackageRoot } from '../lib/managedRelease.js'
import { ROOTGRID_VERSION } from '../lib/rootgridVersion.js'

export function createReleaseBundleManager() {
  let cached = null
  let inflight = null

  function getBundleMetadata() {
    return {
      version: cached?.version ?? ROOTGRID_VERSION,
      releaseId: cached?.releaseId ?? null,
      ready: Boolean(cached)
    }
  }

  async function getBundle() {
    if (cached) return cached
    if (inflight) return await inflight
    inflight = createManagedReleaseBundle({
      sourceRoot: getCurrentPackageRoot(),
      version: ROOTGRID_VERSION,
      source: 'host'
    }).then((bundle) => {
      cached = bundle
      return bundle
    }).finally(() => {
      inflight = null
    })
    return await inflight
  }

  function warmBundle() {
    void getBundle().catch(() => {})
  }

  async function sendBundleToMachine({
    machineId,
    requestId,
    runnerWs,
    makeEnvelope,
    bundle = null
  }) {
    const release = bundle ?? await getBundle()

    const startOk = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'machine.upgrade.start',
      scope: { machineId },
      payload: {
        requestId,
        releaseId: release.releaseId,
        version: release.version,
        filename: release.filename,
        sizeBytes: release.sizeBytes,
        sha256: release.sha256
      }
    }))
    if (!startOk) throw new Error('runner not connected')

    return release
  }

  async function streamBundleToMachine({
    machineId,
    requestId,
    runnerWs,
    makeEnvelope
  }) {
    const bundle = await getBundle()

    try {
      for await (const chunk of createReadStream(bundle.bundlePath, { highWaterMark: 1024 * 1024 })) {
        const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
          type: 'machine.upgrade.chunk',
          scope: { machineId },
          payload: {
            requestId,
            chunkBase64: Buffer.from(chunk).toString('base64')
          }
        }))
        if (!ok) throw new Error('runner not connected')
      }

      const endOk = runnerWs.sendToMachine(machineId, makeEnvelope({
        type: 'machine.upgrade.end',
        scope: { machineId },
        payload: { requestId }
      }))
      if (!endOk) throw new Error('runner not connected')
      return bundle
    } catch (err) {
      try {
        runnerWs.sendToMachine(machineId, makeEnvelope({
          type: 'machine.upgrade.abort',
          scope: { machineId },
          payload: { requestId }
        }))
      } catch {
      }
      throw err
    }
  }

  return {
    getBundle,
    getBundleMetadata,
    warmBundle,
    sendBundleToMachine,
    streamBundleToMachine,
    nextRequestId() {
      return crypto.randomUUID()
    }
  }
}
