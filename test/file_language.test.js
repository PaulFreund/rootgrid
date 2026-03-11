import test from 'node:test'
import assert from 'node:assert/strict'

import { inferFileLanguage } from '../web/src/lib/fileLanguage.js'

test('inferFileLanguage covers common workspace file types', () => {
  assert.equal(inferFileLanguage('src/app.ts'), 'typescript')
  assert.equal(inferFileLanguage('src/app.jsx'), 'javascript')
  assert.equal(inferFileLanguage('web/App.vue'), 'html')
  assert.equal(inferFileLanguage('query.sql'), 'sql')
  assert.equal(inferFileLanguage('Dockerfile'), 'dockerfile')
  assert.equal(inferFileLanguage('ops/deploy.yaml'), 'yaml')
  assert.equal(inferFileLanguage('bin/setup.sh'), 'shell')
  assert.equal(inferFileLanguage('.env'), 'ini')
  assert.equal(inferFileLanguage('main.rs'), 'rust')
  assert.equal(inferFileLanguage('config.txt'), 'plaintext')
  assert.equal(inferFileLanguage(''), 'plaintext')
})
