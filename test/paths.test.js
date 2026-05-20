import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getConfigPath,
  getCurrentReleaseLinkPath,
  getRunnerUploadsDir
} from '../src/lib/paths.js'

test('getRunnerUploadsDir namespaces runner uploads by machine id', () => {
  const out = getRunnerUploadsDir('machine/one')
  assert.match(out, /uploads/)
  assert.match(out, /runner/)
  assert.match(out, /machine_one$/)
})

test('runtime paths can be separated from data paths with ROOTGRID_RUNTIME_DIR', () => {
  const previousHome = process.env.ROOTGRID_HOME_DIR
  const previousRuntime = process.env.ROOTGRID_RUNTIME_DIR
  process.env.ROOTGRID_HOME_DIR = '/tmp/rootgrid-data'
  process.env.ROOTGRID_RUNTIME_DIR = '/tmp/rootgrid-runtime'

  try {
    assert.equal(getConfigPath(), '/tmp/rootgrid-data/config.json')
    assert.equal(getCurrentReleaseLinkPath(), '/tmp/rootgrid-runtime/current')
  } finally {
    if (previousHome === undefined) delete process.env.ROOTGRID_HOME_DIR
    else process.env.ROOTGRID_HOME_DIR = previousHome
    if (previousRuntime === undefined) delete process.env.ROOTGRID_RUNTIME_DIR
    else process.env.ROOTGRID_RUNTIME_DIR = previousRuntime
  }
})

test('ROOTGRID_INSTALL_DIR is honored as a legacy runtime-dir alias', () => {
  const previousHome = process.env.ROOTGRID_HOME_DIR
  const previousRuntime = process.env.ROOTGRID_RUNTIME_DIR
  const previousInstall = process.env.ROOTGRID_INSTALL_DIR
  process.env.ROOTGRID_HOME_DIR = '/tmp/rootgrid-data'
  delete process.env.ROOTGRID_RUNTIME_DIR
  process.env.ROOTGRID_INSTALL_DIR = '/tmp/rootgrid-install'

  try {
    assert.equal(getConfigPath(), '/tmp/rootgrid-data/config.json')
    assert.equal(getCurrentReleaseLinkPath(), '/tmp/rootgrid-install/current')
  } finally {
    if (previousHome === undefined) delete process.env.ROOTGRID_HOME_DIR
    else process.env.ROOTGRID_HOME_DIR = previousHome
    if (previousRuntime === undefined) delete process.env.ROOTGRID_RUNTIME_DIR
    else process.env.ROOTGRID_RUNTIME_DIR = previousRuntime
    if (previousInstall === undefined) delete process.env.ROOTGRID_INSTALL_DIR
    else process.env.ROOTGRID_INSTALL_DIR = previousInstall
  }
})
