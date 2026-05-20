import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildEnableSystemdUserLingerCommand,
  ensureSystemdUserLinger,
  getSystemdUserLingerStatus,
  parseSystemdUserLingerValue
} from '../src/setup/systemdUserAutostart.js'

test('parseSystemdUserLingerValue recognizes loginctl yes/no output', () => {
  assert.equal(parseSystemdUserLingerValue('yes\n'), true)
  assert.equal(parseSystemdUserLingerValue(' no '), false)
  assert.equal(parseSystemdUserLingerValue('maybe'), null)
})

test('buildEnableSystemdUserLingerCommand shell-quotes the username safely', () => {
  assert.equal(
    buildEnableSystemdUserLingerCommand(`paul'o`),
    `sudo loginctl enable-linger 'paul'"'"'o'`
  )
})

test('getSystemdUserLingerStatus normalizes loginctl output', async () => {
  const enabled = await getSystemdUserLingerStatus({
    username: 'alice',
    runCapture: async () => ({ ok: true, stdout: 'yes\n', stderr: '' })
  })
  assert.equal(enabled.supported, true)
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.username, 'alice')

  const disabled = await getSystemdUserLingerStatus({
    username: 'alice',
    runCapture: async () => ({ ok: true, stdout: 'no\n', stderr: '' })
  })
  assert.equal(disabled.supported, true)
  assert.equal(disabled.enabled, false)
})

test('ensureSystemdUserLinger enables linger when it is disabled', async () => {
  const calls = []
  let enabled = false

  const out = await ensureSystemdUserLinger({
    username: 'alice',
    runCapture: async (command, args) => {
      calls.push([command, args])
      if (command === 'loginctl' && args[0] === 'show-user') {
        return { ok: true, stdout: enabled ? 'yes\n' : 'no\n', stderr: '' }
      }
      const joined = `${command} ${args.join(' ')}`
      if (joined.includes('enable-linger alice')) {
        enabled = true
        return { ok: true, stdout: '', stderr: '' }
      }
      return { ok: false, stdout: '', stderr: 'unexpected command' }
    }
  })

  assert.equal(out.supported, true)
  assert.equal(out.enabled, true)
  assert.equal(out.changed, true)
  assert.equal(calls.length, 3)
})
