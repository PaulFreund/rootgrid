import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyAutostartConfig,
  buildUserServiceInstallOptions,
  chooseUserServiceMethod
} from '../src/setup/localRuntimeCommands.js'
import { buildDefaultConfig } from '../src/config/defaultConfig.js'

test('chooseUserServiceMethod prefers the configured method only when available', () => {
  assert.equal(chooseUserServiceMethod({
    preferredMethod: 'systemd-user',
    systemdAvailable: true,
    launchdAvailable: true
  }), 'systemd-user')

  assert.equal(chooseUserServiceMethod({
    preferredMethod: 'systemd-user',
    systemdAvailable: false,
    launchdAvailable: true
  }), 'launchd-user')

  assert.equal(chooseUserServiceMethod({
    preferredMethod: null,
    systemdAvailable: false,
    launchdAvailable: true
  }), 'launchd-user')
})

test('buildUserServiceInstallOptions targets the managed current release', () => {
  const config = buildDefaultConfig()
  const options = buildUserServiceInstallOptions(config, {
    execPath: '/usr/bin/node',
    env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/codex-home' },
    currentReleasePath: '/home/test/.rootgrid/current'
  })

  assert.equal(options.description, 'Rootgrid (Codex web UI + runner)')
  assert.deepEqual(options.execStart, ['/usr/bin/node', '/home/test/.rootgrid/current/src/cli.js'])
  assert.equal(options.workingDirectory, '/home/test/.rootgrid/current')
  assert.deepEqual(options.environment, {
    PATH: '/usr/bin',
    CODEX_HOME: '/tmp/codex-home'
  })
})

test('applyAutostartConfig toggles autostart state safely', () => {
  const config = buildDefaultConfig()

  const enabled = applyAutostartConfig(config, { enabled: true, method: 'systemd-user' })
  assert.equal(enabled.autostart.enabled, true)
  assert.equal(enabled.autostart.method, 'systemd-user')

  const disabled = applyAutostartConfig(enabled, { enabled: false, method: null })
  assert.equal(disabled.autostart.enabled, false)
  assert.equal(disabled.autostart.method, null)
})
