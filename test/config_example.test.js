import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { RootgridConfigSchema } from '../src/config/schema.js'

test('config.example.json includes all config fields and validates against the schema', async () => {
  const raw = await readFile(new URL('../config.example.json', import.meta.url), 'utf8')
  const parsed = JSON.parse(raw)
  const validated = RootgridConfigSchema.parse(parsed)

  assert.equal(validated.version, 1)
  assert.ok(Object.hasOwn(parsed, 'retentionDays'))
  assert.ok(Object.hasOwn(parsed, 'notifications'))
  assert.ok(Object.hasOwn(parsed, 'debug'))
  assert.ok(Object.hasOwn(parsed, 'autostart'))
  assert.ok(Object.hasOwn(parsed, 'runner'))
  assert.ok(Object.hasOwn(parsed, 'host'))
  assert.ok(Object.hasOwn(parsed, 'upstream'))
  assert.ok(Object.hasOwn(parsed.debug, 'codexRawCapture'))
  assert.ok(Object.hasOwn(parsed.host, 'listen'))
  assert.ok(Object.hasOwn(parsed.host, 'publicUrl'))
  assert.ok(Object.hasOwn(parsed.host, 'trustProxy'))
  assert.ok(Object.hasOwn(parsed.host, 'auth'))
})
