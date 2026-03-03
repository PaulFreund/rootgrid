import { homedir } from 'node:os'
import { join } from 'node:path'

export function getRootgridDir() {
  return join(homedir(), '.rootgrid')
}

export function getConfigPath() {
  return join(getRootgridDir(), 'config.json')
}

export function getDbPath() {
  return join(getRootgridDir(), 'rootgrid.db')
}

export function getSecretKeyPath() {
  return join(getRootgridDir(), 'secret.key')
}

export function getVapidKeysPath() {
  return join(getRootgridDir(), 'vapid.json')
}

export function getUploadsDir() {
  return join(getRootgridDir(), 'uploads')
}
