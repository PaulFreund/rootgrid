import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendWorkspaceTerminalOutput,
  normalizeTerminalGeometry,
  workspaceTerminalSessionMatchesContext
} from '../web/src/lib/workspaceTerminal.js'

test('normalizeTerminalGeometry clamps invalid values to terminal-safe bounds', () => {
  assert.deepEqual(normalizeTerminalGeometry(null, null), { cols: 80, rows: 24 })
  assert.deepEqual(normalizeTerminalGeometry(2, 1), { cols: 20, rows: 5 })
  assert.deepEqual(normalizeTerminalGeometry(500, 300), { cols: 400, rows: 200 })
})

test('appendWorkspaceTerminalOutput appends chunks and keeps the tail when capped', () => {
  assert.equal(appendWorkspaceTerminalOutput('hello', ' world'), 'hello world')
  assert.equal(appendWorkspaceTerminalOutput('abcdef', 'ghij', 8), 'cdefghij')
})

test('workspaceTerminalSessionMatchesContext requires matching machine and cwd', () => {
  const session = {
    terminalId: 'term-1',
    machineId: 'machine-1',
    cwd: '/tmp/workspace'
  }
  assert.equal(workspaceTerminalSessionMatchesContext(session, { machineId: 'machine-1', cwd: '/tmp/workspace' }), true)
  assert.equal(workspaceTerminalSessionMatchesContext(session, { machineId: 'machine-2', cwd: '/tmp/workspace' }), false)
  assert.equal(workspaceTerminalSessionMatchesContext(session, { machineId: 'machine-1', cwd: '/tmp/other' }), false)
})
