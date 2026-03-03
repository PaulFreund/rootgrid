import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import webPush from 'web-push'

import { getRootgridDir, getVapidKeysPath } from './paths.js'

/**
 * @typedef {{ publicKey: string, privateKey: string }} VapidKeys
 */

/**
 * @returns {Promise<VapidKeys>}
 */
export async function getOrCreateVapidKeys() {
  const dir = getRootgridDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try { await chmod(dir, 0o700) } catch { }

  const path = getVapidKeysPath()
  const existing = await readVapidKeys(path)
  if (existing) return existing

  const generated = webPush.generateVAPIDKeys()
  const keys = { publicKey: generated.publicKey, privateKey: generated.privateKey }

  const tmp = `${path}.tmp-${Date.now()}`
  await writeFile(tmp, JSON.stringify(keys, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  await rename(tmp, path)
  try { await chmod(path, 0o600) } catch { }

  return keys
}

/**
 * @param {string} path
 * @returns {Promise<VapidKeys|null>}
 */
async function readVapidKeys(path) {
  try {
    const raw = await readFile(path, 'utf-8')
    const json = JSON.parse(raw)
    if (!json || typeof json !== 'object') return null
    const publicKey = json.publicKey
    const privateKey = json.privateKey
    if (typeof publicKey !== 'string' || !publicKey) return null
    if (typeof privateKey !== 'string' || !privateKey) return null
    return { publicKey, privateKey }
  } catch {
    return null
  }
}
