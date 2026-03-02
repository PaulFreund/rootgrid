import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJsonFile(path) {
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw)
}

export async function writeJsonFile(path, value, { mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const json = JSON.stringify(value, null, 2) + '\n'
  await writeFile(path, json, { encoding: 'utf-8', mode })
}

