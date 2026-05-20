import test from 'node:test'
import assert from 'node:assert/strict'

import { applyCodeServerDefaultSettings, buildCodeServerEnv, buildCodeServerLaunchSpec, listCodeServerCommandCandidates } from '../src/runner/ideManager.js'

test('buildCodeServerLaunchSpec uses a persistent code-server user-data dir and per-IDE runtime dir', () => {
  const spec = buildCodeServerLaunchSpec({
    ideId: 'ide-123',
    machineId: 'machine-1',
    port: 4545,
    cwd: '/tmp/workspace',
    capabilities: {
      supportsDisableWorkspaceTrust: true,
      supportsDisableGettingStartedOverride: true,
      supportsAbsProxyBasePath: true,
      supportsBasePath: false,
      trustedOrigins: ['rootgrid.example.test:7337']
    }
  })

  assert.equal(spec.basePath, '/vscode/ide-123')
  assert.ok(spec.runtimeDir.includes('/.rootgrid/tmp/ide/machine-1/ide-123'))
  assert.ok(spec.userDataDir.includes('/.rootgrid/ide/machine-1/code-server-user-data'))
  assert.deepEqual(spec.args.slice(0, 11), [
    '--auth', 'none',
    '--bind-addr', '127.0.0.1:4545',
    '--disable-telemetry',
    '--disable-update-check',
    '--ignore-last-opened',
    '--user-data-dir', spec.userDataDir,
    '--disable-workspace-trust',
    '--disable-getting-started-override'
  ])
  assert.equal(spec.args[11], '--abs-proxy-base-path')
  assert.equal(spec.args[12], '/vscode/ide-123')
  assert.equal(spec.args[13], '--trusted-origins')
  assert.equal(spec.args[14], 'rootgrid.example.test:7337')
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

test('applyCodeServerDefaultSettings seeds hidden AI chrome without overwriting user choices', () => {
  assert.deepEqual(applyCodeServerDefaultSettings({}), {
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.commandCenter.enabled': false
  })

  assert.deepEqual(applyCodeServerDefaultSettings({
    'chat.commandCenter.enabled': true,
    'workbench.secondarySideBar.defaultVisibility': 'visible',
    'workbench.colorTheme': 'Default Dark+'
  }), {
    'chat.commandCenter.enabled': true,
    'workbench.secondarySideBar.defaultVisibility': 'visible',
    'workbench.colorTheme': 'Default Dark+'
  })
})

test('listCodeServerCommandCandidates includes PATH and common fallback locations', () => {
  const candidates = listCodeServerCommandCandidates({
    HOME: '/home/test',
    PATH: '/custom/bin:/usr/bin',
    ROOTGRID_RUNTIME_DIR: '/home/test/.rootgrid-runtime',
    ROOTGRID_CODE_SERVER_BIN: '/special/code-server'
  })

  assert.deepEqual(candidates.slice(0, 6), [
    '/special/code-server',
    '/home/test/.rootgrid-runtime/tools/code-server/home/.local/bin/code-server',
    '/custom/bin/code-server',
    '/usr/bin/code-server',
    '/home/test/.local/bin/code-server',
    '/usr/local/bin/code-server'
  ])
  assert.ok(candidates.includes('/opt/homebrew/bin/code-server'))
  assert.ok(candidates.includes('/home/linuxbrew/.linuxbrew/bin/code-server'))
})
