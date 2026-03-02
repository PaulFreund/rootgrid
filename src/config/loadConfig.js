import { access } from 'node:fs/promises'

import { getConfigPath } from '../lib/paths.js'
import { readJsonFile } from '../lib/jsonFile.js'
import { RootgridConfigSchema } from './schema.js'

export async function loadConfig() {
  const path = getConfigPath()
  try {
    await access(path)
  } catch {
    throw new Error(`Missing config: ${path}. Run: rootgrid setup`)
  }

  const raw = await readJsonFile(path)
  const parsed = RootgridConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid config at ${path}:\n${issues}`)
  }

  return parsed.data
}
