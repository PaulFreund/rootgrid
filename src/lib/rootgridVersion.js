import { readFileSync } from 'node:fs'

let version = '0.0.0'

try {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  const parsed = JSON.parse(raw)
  const next = String(parsed?.version ?? '').trim()
  if (next) version = next
} catch {
}

export const ROOTGRID_VERSION = version
