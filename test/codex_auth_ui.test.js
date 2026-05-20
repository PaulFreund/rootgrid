import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLegacyCodexAuthTool,
  detectCodexAuthIssueFromSessionError,
  detectCodexAuthIssueText,
  detectCodexMissingIssueText
} from '../web/src/lib/codexAuthUi.js'

test('detectCodexAuthIssueText recognizes reused refresh tokens', () => {
  const out = detectCodexAuthIssueText(`
Failed to refresh token: 401 Unauthorized
refresh_token_reused
Please sign in again.
`)

  assert.equal(out?.code, 'refresh_token_reused')
  assert.match(String(out?.message ?? ''), /sign-in again/i)
})

test('buildLegacyCodexAuthTool maps session auth issues into a Codex auth card model', () => {
  const out = buildLegacyCodexAuthTool({
    code: 'refresh_token_reused',
    message: 'Codex needs ChatGPT sign-in again on this runner.'
  })

  assert.equal(out?.id, 'codex')
  assert.equal(out?.auth?.status, 'reauth-required')
  assert.equal(out?.auth?.code, 'refresh_token_reused')
})

test('detectCodexAuthIssueFromSessionError reads message and details', () => {
  const out = detectCodexAuthIssueFromSessionError({
    message: 'Codex refresh token was already used. Log out and sign in again on this runner.',
    details: 'refresh_token_reused'
  })

  assert.equal(out?.code, 'refresh_token_reused')
})

test('detectCodexAuthIssueFromSessionError prefers structured error codes', () => {
  const out = detectCodexAuthIssueFromSessionError({
    code: 'refresh_token_reused',
    message: 'Codex needs ChatGPT sign-in again on this runner.',
    details: 'Use Settings > Machines > Runner tools > Codex to start ChatGPT sign-in again.'
  })

  assert.equal(out?.code, 'refresh_token_reused')
  assert.match(String(out?.message ?? ''), /sign-in again/i)
})

test('detectCodexMissingIssueText recognizes managed codex spawn failures', () => {
  const out = detectCodexMissingIssueText('spawn /home/wook/.rootgrid-dev/tools/codex/npm-global/bin/codex ENOENT')

  assert.equal(out?.code, 'codex_missing')
  assert.match(String(out?.message ?? ''), /managed codex is missing/i)
})
