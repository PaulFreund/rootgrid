import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { createRunnerToolsManager } from '../src/runner/runnerToolsManager.js'

test('runner tools manager reports detected tool versions', async () => {
  const manager = createRunnerToolsManager({
    checkCodex: async () => ({ ok: true, version: 'codex-cli 1.2.3', source: 'managed', command: '/home/test/.rootgrid/tools/codex/npm-global/bin/codex' }),
    checkCodeServer: async () => ({ ok: false, version: null, source: 'missing', command: null }),
    async runCommand(command, args) {
      if (command === '/home/test/.rootgrid/tools/codex/npm-global/bin/codex' && args?.[0] === 'login' && args?.[1] === 'status') {
        return { ok: true, code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${Array.isArray(args) ? args.join(' ') : ''}`)
    }
  })

  const tools = await manager.getPublicState()

  assert.equal(tools.codex?.installed, true)
  assert.equal(tools.codex?.version, 'codex-cli 1.2.3')
  assert.equal(tools.codex?.source, 'managed')
  assert.equal(tools.codex?.path, '/home/test/.rootgrid/tools/codex/npm-global/bin/codex')
  assert.equal(tools.codex?.auth?.status, 'authenticated')
  assert.equal(tools.codex?.auth?.provider, 'ChatGPT')
  assert.equal(tools.codeServer?.installed, false)
  assert.equal(tools.codeServer?.version, null)
  assert.deepEqual(manager.capabilities(), { enabled: true, upgrades: true, auth: true })
})

test('runner tools manager upgrades a tool and refreshes its detected version', async () => {
  let codexVersion = null
  const commands = []
  const manager = createRunnerToolsManager({
    checkCodex: async () => ({
      ok: Boolean(codexVersion),
      version: codexVersion,
      source: Boolean(codexVersion) ? 'managed' : 'missing',
      command: Boolean(codexVersion) ? '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex' : null
    }),
    checkCodeServer: async () => ({ ok: true, version: 'code-server 4.0.0', source: 'managed', command: '/tmp/rootgrid-runtime/tools/code-server/home/.local/bin/code-server' }),
    async runCommand(command, args) {
      commands.push([command, ...args].join(' '))
      codexVersion = 'codex-cli 9.9.9'
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
  })

  const result = await manager.upgrade('codex')

  assert.match(commands[0], /^\/bin\/sh -lc mkdir -p '.*\/tools\/codex\/npm-global' && npm install --global --prefix '.*\/tools\/codex\/npm-global' @openai\/codex/)
  assert.match(commands[0], /rootgrid_install_system_bubblewrap/)
  assert.match(commands[0], /apt-get install -y bubblewrap/)
  assert.equal(result?.ok, true)
  assert.equal(result?.tool?.version, 'codex-cli 9.9.9')
  assert.equal(result?.tool?.source, 'managed')
  assert.equal(result?.tools?.codex?.version, 'codex-cli 9.9.9')
  assert.match(result?.message ?? '', /managed install is now codex-cli 9\.9\.9/i)
})

test('runner tools manager installs code-server into the managed standalone path', async () => {
  let codeServerSource = 'external'
  let codeServerCommand = '/usr/bin/code-server'
  const commands = []
  const manager = createRunnerToolsManager({
    checkCodex: async () => ({
      ok: true,
      version: 'codex-cli 1.2.3',
      source: 'managed',
      command: '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex'
    }),
    checkCodeServer: async () => ({
      ok: true,
      version: '4.111.0',
      source: codeServerSource,
      command: codeServerCommand
    }),
    async runCommand(command, args) {
      commands.push([command, ...args].join(' '))
      codeServerSource = 'managed'
      codeServerCommand = '/tmp/rootgrid-runtime/tools/code-server/home/.local/bin/code-server'
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
  })

  const result = await manager.upgrade('codeServer')

  assert.equal(commands.some((entry) => /curl -fsSL https:\/\/code-server\.dev\/install\.sh \| sh -s -- --method=standalone/.test(entry)), true)
  assert.equal(result?.ok, true)
  assert.equal(result?.tool?.source, 'managed')
  assert.equal(result?.tool?.path, '/tmp/rootgrid-runtime/tools/code-server/home/.local/bin/code-server')
  assert.equal(result?.tools?.codeServer?.source, 'managed')
  assert.match(result?.message ?? '', /managed install is now 4\.111\.0/i)
})

test('runner tools manager surfaces Codex bubblewrap install warnings', async () => {
  let codexVersion = null
  const manager = createRunnerToolsManager({
    checkCodex: async () => ({
      ok: Boolean(codexVersion),
      version: codexVersion,
      source: Boolean(codexVersion) ? 'managed' : 'missing',
      command: Boolean(codexVersion) ? '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex' : null
    }),
    checkCodeServer: async () => ({ ok: false, version: null, source: 'missing', command: null }),
    async runCommand() {
      codexVersion = 'codex-cli 9.9.9'
      return {
        ok: true,
        code: 0,
        stdout: '',
        stderr: "[rootgrid] bubblewrap could not be installed automatically; install package 'bubblewrap' on this runner to avoid Codex's vendored fallback warning.\n"
      }
    }
  })

  const result = await manager.upgrade('codex')

  assert.equal(result?.ok, true)
  assert.match(result?.message ?? '', /managed install is now codex-cli 9\.9\.9/i)
  assert.match(result?.message ?? '', /bubblewrap could not be installed automatically/i)
})

test('runner tools manager keeps Codex reauth-required after a detected auth failure until explicit refresh', async () => {
  let loginChecks = 0
  const manager = createRunnerToolsManager({
    checkCodex: async () => ({
      ok: true,
      version: 'codex-cli 1.2.3',
      source: 'managed',
      command: '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex'
    }),
    checkCodeServer: async () => ({ ok: false, version: null, source: 'missing', command: null }),
    async runCommand(command, args) {
      if (command === '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex' && args?.[0] === 'login' && args?.[1] === 'status') {
        loginChecks += 1
        return { ok: true, code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${Array.isArray(args) ? args.join(' ') : ''}`)
    }
  })

  await manager.getPublicState()
  manager.reportCodexAuthIssue('Failed to refresh token: 401 Unauthorized: refresh_token_reused')
  const afterIssue = await manager.getPublicState()
  const refreshed = await manager.auth('codex', 'refresh')

  assert.equal(afterIssue.codex?.auth?.status, 'reauth-required')
  assert.equal(afterIssue.codex?.auth?.code, 'refresh_token_reused')
  assert.equal(refreshed.tool?.auth?.status, 'authenticated')
  assert.equal(refreshed.tool?.auth?.provider, 'ChatGPT')
  assert.equal(loginChecks >= 2, true)
})

test('runner tools manager can log Codex in with an API key', async () => {
  const calls = []
  let authenticated = false
  const manager = createRunnerToolsManager({
    checkCodex: async () => ({
      ok: true,
      version: 'codex-cli 1.2.3',
      source: 'managed',
      command: '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex'
    }),
    checkCodeServer: async () => ({ ok: false, version: null, source: 'missing', command: null }),
    async runCommand(command, args, options = {}) {
      calls.push({ command, args, input: options.input ?? null })
      if (command === '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex' && args?.[0] === 'login' && args?.[1] === 'status') {
        return authenticated
          ? { ok: true, code: 0, stdout: 'Logged in using API key\n', stderr: '' }
          : { ok: false, code: 1, stdout: 'Not logged in\n', stderr: '' }
      }
      if (command === '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex' && args?.[0] === 'login' && args?.[1] === '--with-api-key') {
        authenticated = true
        return { ok: true, code: 0, stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${Array.isArray(args) ? args.join(' ') : ''}`)
    }
  })

  const result = await manager.auth('codex', 'loginApiKey', { apiKey: 'sk-test-123' })

  assert.equal(result.ok, true)
  assert.equal(result.tool?.auth?.status, 'authenticated')
  assert.equal(result.tool?.auth?.provider, 'API key')
  assert.equal(calls.some((entry) => entry.args?.[0] === 'login' && entry.args?.[1] === '--with-api-key' && entry.input === 'sk-test-123\n'), true)
})

test('runner tools manager starts and tracks Codex browser sign-in', async () => {
  let loginChecks = 0
  let authenticated = false
  let child = null
  const manager = createRunnerToolsManager({
    checkCodex: async () => ({
      ok: true,
      version: 'codex-cli 1.2.3',
      source: 'managed',
      command: '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex'
    }),
    checkCodeServer: async () => ({ ok: false, version: null, source: 'missing', command: null }),
    async runCommand(command, args) {
      if (command === '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex' && args?.[0] === 'login' && args?.[1] === 'status') {
        loginChecks += 1
        return authenticated
          ? { ok: true, code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
          : { ok: false, code: 1, stdout: 'Not logged in\n', stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${Array.isArray(args) ? args.join(' ') : ''}`)
    },
    spawnProcess(command, args) {
      assert.equal(command, '/tmp/rootgrid-runtime/tools/codex/npm-global/bin/codex')
      assert.deepEqual(args, ['login', '--device-auth'])
      child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {
        child.emit('close', null, 'SIGTERM')
        return true
      }
      return child
    }
  })

  await manager.getPublicState()
  const started = await manager.auth('codex', 'startDeviceAuth')
  child.stdout.write(`
Welcome to Codex [v0.114.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   ABCD-EFGH1

Device codes are a common phishing target. Never share this code.
`)
  const midFlow = await manager.getPublicState()
  child.stdout.write('\nSuccessfully logged in\n')
  authenticated = true
  child.emit('close', 0, null)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 350))
  const finished = await manager.getPublicState()

  assert.equal(started.ok, true)
  assert.equal(midFlow.codex?.auth?.flow?.active, true)
  assert.equal(midFlow.codex?.auth?.flow?.verificationUrl, 'https://auth.openai.com/codex/device')
  assert.equal(midFlow.codex?.auth?.flow?.userCode, 'ABCD-EFGH1')
  assert.equal(String(midFlow.codex?.auth?.flow?.output ?? '').includes('command-line coding agent'), true)
  assert.equal(finished.codex?.auth?.status, 'authenticated')
  assert.equal(finished.codex?.auth?.provider, 'ChatGPT')
  assert.equal(finished.codex?.auth?.flow?.status, 'completed')
  assert.equal(loginChecks >= 2, true)
})
