import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  extractManagedReleaseBundle,
  getCurrentReleaseLinkPath,
  getReleaseTransfersDir,
  getReleasesDir,
  pruneOldManagedReleases,
  switchCurrentRelease
} from '../lib/managedRelease.js'
import { dispatchUserServiceRestart } from '../lib/userServiceRuntime.js'
import { writeAll } from '../lib/writeAll.js'

function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

async function currentProcessUsesManagedRuntime() {
  const script = trimText(process.argv?.[1])
  if (!script) return false
  try {
    const [scriptReal, currentReal] = await Promise.all([
      realpath(script),
      realpath(getCurrentReleaseLinkPath())
    ])
    return scriptReal.startsWith(resolve(currentReal))
  } catch {
    return false
  }
}

export class RunnerReleaseManager {
  /**
   * @param {{
   *   machineId: string,
   *   emit: (type: string, payload: any, options?: { track?: boolean }) => void,
   *   autostart?: any,
   *   upgrade?: any,
   *   restartService?: (method: string|null|undefined) => boolean
   * }} opts
   */
  constructor({ machineId, emit, autostart = null, upgrade = null, restartService = dispatchUserServiceRestart }) {
    this.machineId = machineId
    this.emit = emit
    this.autostart = autostart ?? { enabled: false, method: null }
    this.upgrade = {
      enabled: upgrade?.enabled !== false,
      keepReleases: Number(upgrade?.keepReleases) > 0 ? Number(upgrade.keepReleases) : 3
    }
    this.restartService = restartService
    this.transfer = null
  }

  async capabilities() {
    const managedRuntime = await currentProcessUsesManagedRuntime()
    return {
      enabled: Boolean(this.upgrade.enabled && this.autostart?.enabled && this.autostart?.method && managedRuntime),
      mode: 'managed-release',
      managedRuntime,
      autostartMethod: this.autostart?.method ?? null
    }
  }

  #emitState(state, message = null) {
    this.emit('machine.upgrade.state', {
      machineId: this.machineId,
      state,
      ...(message ? { message } : {})
    }, { track: false })
  }

  async begin(payload) {
    const requestId = trimText(payload?.requestId)
    const releaseId = trimText(payload?.releaseId)
    const version = trimText(payload?.version)
    const sha256 = trimText(payload?.sha256)
    const filename = trimText(payload?.filename) ?? `${releaseId || 'rootgrid'}.tgz`
    const sizeBytes = Number(payload?.sizeBytes ?? 0)

    if (!requestId || !releaseId || !version || !sha256 || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error('invalid release metadata')
    }

    const capabilities = await this.capabilities()
    if (!capabilities.enabled) throw new Error('managed remote upgrade is unavailable on this runner')
    if (this.transfer) throw new Error('another managed upgrade is already running')

    const transfersDir = getReleaseTransfersDir()
    await mkdir(transfersDir, { recursive: true, mode: 0o700 })
    const archivePath = join(transfersDir, `${releaseId}.tgz`)
    const file = await open(archivePath, 'w', 0o600)

    this.transfer = {
      requestId,
      releaseId,
      version,
      sha256,
      sizeBytes,
      archivePath,
      releaseDir: join(getReleasesDir(), releaseId),
      file,
      receivedBytes: 0,
      hash: createHash('sha256'),
      queue: Promise.resolve()
    }

    this.#emitState('starting')
  }

  async chunk(payload) {
    const requestId = trimText(payload?.requestId)
    const chunkBase64 = payload?.chunkBase64
    if (!requestId || typeof chunkBase64 !== 'string') return
    if (!this.transfer || this.transfer.requestId !== requestId) throw new Error('managed upgrade transfer not found')

    const buf = Buffer.from(chunkBase64, 'base64')
    this.transfer.queue = this.transfer.queue.then(async () => {
      await writeAll(this.transfer.file, buf, this.transfer.receivedBytes)
      this.transfer.hash.update(buf)
      this.transfer.receivedBytes += buf.length
    })
    await this.transfer.queue
    this.#emitState('receiving')
  }

  async end(payload) {
    const requestId = trimText(payload?.requestId)
    if (!requestId || !this.transfer || this.transfer.requestId !== requestId) {
      throw new Error('managed upgrade transfer not found')
    }

    const transfer = this.transfer
    try {
      await transfer.queue
      await transfer.file.close()
      if (transfer.receivedBytes !== transfer.sizeBytes) {
        throw new Error(`bundle size mismatch: expected ${transfer.sizeBytes}, got ${transfer.receivedBytes}`)
      }

      const actualSha = transfer.hash.digest('hex')
      if (actualSha !== transfer.sha256) {
        throw new Error('bundle checksum mismatch')
      }

      this.#emitState('installing')
      const manifest = await extractManagedReleaseBundle({
        archivePath: transfer.archivePath,
        targetDir: transfer.releaseDir
      })
      if (String(manifest?.releaseId ?? '') !== transfer.releaseId) throw new Error('release manifest mismatch')
      if (String(manifest?.version ?? '') !== transfer.version) throw new Error('release version mismatch')

      await switchCurrentRelease(transfer.releaseDir)
      await pruneOldManagedReleases({ keep: this.upgrade.keepReleases, excludeReleaseIds: [transfer.releaseId] })

      this.emit('machine.upgrade.bundle.received', {
        requestId: transfer.requestId,
        machineId: this.machineId,
        releaseId: transfer.releaseId,
        version: transfer.version
      }, { track: false })

      this.#emitState('restarting')
      try {
        this.restartService(this.autostart?.method)
      } catch (err) {
        throw new Error(String(err?.message ?? err))
      }
    } catch (err) {
      this.emit('machine.upgrade.bundle.failed', {
        requestId: transfer.requestId,
        machineId: this.machineId,
        error: String(err?.message ?? err)
      }, { track: false })
      this.#emitState('failed', String(err?.message ?? err))
      await rm(transfer.releaseDir, { recursive: true, force: true }).catch(() => {})
      throw err
    } finally {
      await rm(transfer.archivePath, { force: true }).catch(() => {})
      this.transfer = null
    }
  }

  async abort(payload) {
    const requestId = trimText(payload?.requestId)
    if (!requestId || !this.transfer || this.transfer.requestId !== requestId) return
    const transfer = this.transfer
    this.transfer = null
    try { await transfer.file.close() } catch {}
    await rm(transfer.archivePath, { force: true }).catch(() => {})
    this.#emitState('failed', 'upgrade aborted')
  }
}
