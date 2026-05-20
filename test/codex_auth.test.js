import test from 'node:test'
import assert from 'node:assert/strict'

import { codexDeviceAuthSucceeded, parseCodexDeviceAuthOutput, stripAnsiText } from '../src/lib/codexAuth.js'

test('stripAnsiText removes terminal escape sequences', () => {
  const out = stripAnsiText('\u001b[0mhttps://auth.openai.com/codex/device\u001b[0m')
  assert.equal(out, 'https://auth.openai.com/codex/device')
})

test('parseCodexDeviceAuthOutput extracts clean verification URL and authorization code', () => {
  const out = parseCodexDeviceAuthOutput(`
\u001b[0mOpen this URL in your browser:\u001b[0m
\u001b[0mhttps://auth.openai.com/codex/device\u001b[0m
\u001b[0mAuthorization code\u001b[0m
\u001b[94mYAD6-AKQKF0\u001b[0m
\u001b[90mDevice codes are a common phishing target.\u001b[0m
`)

  assert.equal(out.verificationUrl, 'https://auth.openai.com/codex/device')
  assert.equal(out.userCode, 'YAD6-AKQKF0')
})

test('parseCodexDeviceAuthOutput ignores banner text and extracts the one-time code from full login output', () => {
  const out = parseCodexDeviceAuthOutput(`
Welcome to Codex [v0.114.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   YF2R-EIN9B

Device codes are a common phishing target. Never share this code.

Successfully logged in
`)

  assert.equal(out.verificationUrl, 'https://auth.openai.com/codex/device')
  assert.equal(out.userCode, 'YF2R-EIN9B')
})

test('codexDeviceAuthSucceeded detects successful login output without matching banner text', () => {
  assert.equal(codexDeviceAuthSucceeded('Successfully logged in'), true)
  assert.equal(codexDeviceAuthSucceeded('Logged in using ChatGPT'), true)
  assert.equal(codexDeviceAuthSucceeded('OpenAI command-line coding agent'), false)
})
