import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyAutostartConfig,
  buildUserServiceInstallOptions,
  chooseUserServiceMethod,
  usesManagedRuntimeForConfig
} from '../src/setup/localRuntimeCommands.js'
import { buildDefaultConfig } from '../src/config/defaultConfig.js'
import { buildSystemdUserUnit } from '../src/setup/systemdUserAutostart.js'

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
  const runnerOnlyConfig = buildDefaultConfig()
  runnerOnlyConfig.host.enabled = false
  runnerOnlyConfig.upstream.enabled = true

  const runnerOptions = buildUserServiceInstallOptions(runnerOnlyConfig, {
    execPath: '/usr/bin/node',
    env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/codex-home' },
    packageRoot: '/src/rootgrid',
    currentReleasePath: '/home/test/.rootgrid/current'
  })

  assert.equal(runnerOptions.description, 'Rootgrid (runner)')
  assert.deepEqual(runnerOptions.execStart, ['/usr/bin/node', '/home/test/.rootgrid/current/src/cli.js'])
  assert.equal(runnerOptions.workingDirectory, '/home/test/.rootgrid/current')
  assert.deepEqual(runnerOptions.environment, {
    PATH: '/usr/bin',
    CODEX_HOME: '/tmp/codex-home'
  })

  const hostConfig = buildDefaultConfig()
  const hostOptions = buildUserServiceInstallOptions(hostConfig, {
    execPath: '/usr/bin/node',
    env: { PATH: '/usr/bin' },
    packageRoot: '/src/rootgrid',
    currentReleasePath: '/home/test/.rootgrid/current'
  })

  assert.equal(hostOptions.description, 'Rootgrid (Codex web UI + runner)')
  assert.deepEqual(hostOptions.execStart, ['/usr/bin/node', '/src/rootgrid/src/cli.js'])
  assert.equal(hostOptions.workingDirectory, '/src/rootgrid')
})

test('usesManagedRuntimeForConfig is runner-only', () => {
  const hostConfig = buildDefaultConfig()
  assert.equal(usesManagedRuntimeForConfig(hostConfig), false)

  const runnerOnlyConfig = buildDefaultConfig()
  runnerOnlyConfig.host.enabled = false
  runnerOnlyConfig.upstream.enabled = true
  assert.equal(usesManagedRuntimeForConfig(runnerOnlyConfig), true)
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

test('buildSystemdUserUnit restarts the Rootgrid service on any exit', () => {
  const unit = buildSystemdUserUnit({
    description: 'Rootgrid (runner)',
    execStart: ['/usr/bin/node', '/root/.rootgrid/current/src/cli.js'],
    workingDirectory: '/root/.rootgrid/current'
  })

  assert.match(unit, /^Type=simple$/m)
  assert.match(unit, /^Restart=always$/m)
  assert.doesNotMatch(unit, /^Restart=on-failure$/m)
})
