import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDefaultConfig } from '../src/config/defaultConfig.js'
import { RootgridConfigSchema } from '../src/config/schema.js'

test('runner web upgrade config is enabled by default with managed release retention', () => {
  const config = buildDefaultConfig()
  const parsed = RootgridConfigSchema.parse(config)
  assert.equal(parsed.runner.upgrade.enabled, true)
  assert.equal(parsed.runner.upgrade.keepReleases, 3)
})
