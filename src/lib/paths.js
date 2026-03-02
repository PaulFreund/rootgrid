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

