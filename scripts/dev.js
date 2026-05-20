#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import process from 'node:process'
import { ensureDevConfig, resolveDevEnvironment } from './devEnvironment.js'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const devConfig = await ensureDevConfig({ repoDir, env: process.env })
const devEnv = resolveDevEnvironment({ repoDir, env: process.env })

const viteBin = join(repoDir, 'node_modules', 'vite', 'bin', 'vite.js')
const webDir = join(repoDir, 'web')

const host = spawn(node, [join(repoDir, 'src', 'cli.js')], {
  stdio: 'inherit',
  cwd: repoDir,
  env: devEnv
})

const web = spawn(node, [viteBin, '--config', 'vite.config.js'], {
  stdio: 'inherit',
  cwd: webDir,
  env: devEnv
})

console.log(`Rootgrid dev home: ${devEnv.ROOTGRID_HOME_DIR}`)
if (devConfig.created) {
  console.log(`Seeded dev config: ${devConfig.configPath}`)
  if (devConfig.sourcePath) console.log(`Seed source: ${devConfig.sourcePath}`)
}

const shutdown = (code = 0) => {
  try { host.kill('SIGTERM') } catch {}
  try { web.kill('SIGTERM') } catch {}
  process.exit(code)
}

host.on('exit', (code) => shutdown(code ?? 0))
web.on('exit', (code) => shutdown(code ?? 0))

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
