import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCodeServerEnv, buildCodeServerLaunchSpec, listCodeServerCommandCandidates } from '../src/runner/ideManager.js'

test('buildCodeServerLaunchSpec uses a per-IDE user-data dir and base path', () => {
  const spec = buildCodeServerLaunchSpec({
    ideId: 'ide-123',
    machineId: 'machine-1',
    port: 4545,
    cwd: '/tmp/workspace',
    capabilities: {
      supportsAbsProxyBasePath: true,
      supportsBasePath: false,
      trustedOrigins: ['rootgrid.example.test:7337']
    }
  })

  assert.equal(spec.basePath, '/vscode/ide-123')
  assert.ok(spec.userDataDir.includes('/.rootgrid/tmp/ide/machine-1/ide-123/user-data'))
  assert.deepEqual(spec.args.slice(0, 9), [
    '--auth', 'none',
    '--bind-addr', '127.0.0.1:4545',
    '--disable-telemetry',
    '--disable-update-check',
    '--ignore-last-opened',
    '--user-data-dir', spec.userDataDir
  ])
  assert.equal(spec.args[9], '--abs-proxy-base-path')
  assert.equal(spec.args[10], '/vscode/ide-123')
  assert.equal(spec.args[11], '--trusted-origins')
  assert.equal(spec.args[12], 'rootgrid.example.test:7337')
  assert.equal(spec.args.at(-1), '/tmp/workspace')
})

test('buildCodeServerEnv strips VS Code session handoff variables', () => {
  const env = buildCodeServerEnv({
    PATH: '/usr/bin',
    VSCODE_IPC_HOOK_CLI: '/tmp/vscode.sock',
    CODE_SERVER_SESSION_SOCKET: '/tmp/code-server.sock',
    HOME: '/home/test'
  })

  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/test')
  assert.equal('VSCODE_IPC_HOOK_CLI' in env, false)
  assert.equal('CODE_SERVER_SESSION_SOCKET' in env, false)
})

test('listCodeServerCommandCandidates includes PATH and common fallback locations', () => {
  const candidates = listCodeServerCommandCandidates({
    HOME: '/home/test',
    PATH: '/custom/bin:/usr/bin',
    ROOTGRID_CODE_SERVER_BIN: '/special/code-server'
  })

  assert.deepEqual(candidates.slice(0, 6), [
    '/special/code-server',
    '/custom/bin/code-server',
    '/usr/bin/code-server',
    '/home/test/.local/bin/code-server',
    '/usr/local/bin/code-server',
    '/opt/homebrew/bin/code-server'
  ])
  assert.ok(candidates.includes('/home/linuxbrew/.linuxbrew/bin/code-server'))
})
