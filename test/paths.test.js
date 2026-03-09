import test from 'node:test'
import assert from 'node:assert/strict'

import { getRunnerUploadsDir } from '../src/lib/paths.js'

test('getRunnerUploadsDir namespaces runner uploads by machine id', () => {
  const out = getRunnerUploadsDir('machine/one')
  assert.match(out, /uploads/)
  assert.match(out, /runner/)
  assert.match(out, /machine_one$/)
})
