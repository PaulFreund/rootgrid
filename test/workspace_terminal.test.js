import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyWorkspaceTerminalInputModifiers,
  appendWorkspaceTerminalOutput,
  buildWorkspaceTerminalExitNotice,
  createWorkspaceTerminalSession,
  normalizeTerminalGeometry,
  resolveMobileTerminalActionInput,
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

test('workspace terminal helpers build exit notices and normalized session records', () => {
  assert.equal(
    buildWorkspaceTerminalExitNotice({ exitCode: 7, signal: null }),
    '\r\n[process exited with code 7]\r\n'
  )

  assert.deepEqual(createWorkspaceTerminalSession({
    terminalId: 'term-1',
    machineId: 'machine-1',
    cwd: '/tmp/workspace',
    shell: '/bin/bash',
    cols: 120,
    rows: 40,
    outputText: 'hello',
    outputVersion: 3,
    connected: true
  }), {
    terminalId: 'term-1',
    machineId: 'machine-1',
    cwd: '/tmp/workspace',
    shell: '/bin/bash',
    cols: 120,
    rows: 40,
    outputText: 'hello',
    outputVersion: 3,
    outputResetVersion: 1,
    chunkText: '',
    chunkVersion: 0,
    connected: true,
    exitCode: null,
    signal: null
  })
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

test('workspace terminal helpers build mobile modifier and special-key input sequences', () => {
  assert.equal(applyWorkspaceTerminalInputModifiers('c', { ctrl: true }), '\x03')
  assert.equal(applyWorkspaceTerminalInputModifiers('z', { ctrl: true, alt: true }), '\x1b\x1a')
  assert.equal(applyWorkspaceTerminalInputModifiers('a', { shift: true }), 'A')
  assert.equal(applyWorkspaceTerminalInputModifiers('x', { meta: true }), '\x1bx')
  assert.equal(applyWorkspaceTerminalInputModifiers('[', { ctrl: true }), '\x1b')
  assert.equal(resolveMobileTerminalActionInput('esc'), '\x1b')
  assert.equal(resolveMobileTerminalActionInput('tab'), '\t')
  assert.equal(resolveMobileTerminalActionInput('tab', { shift: true }), '\x1b[Z')
  assert.equal(resolveMobileTerminalActionInput('up'), '\x1b[A')
  assert.equal(resolveMobileTerminalActionInput('left', { ctrl: true }), '\x1b[1;5D')
  assert.equal(resolveMobileTerminalActionInput('ins'), '\x1b[2~')
  assert.equal(resolveMobileTerminalActionInput('del'), '\x1b[3~')
  assert.equal(resolveMobileTerminalActionInput('pgdn'), '\x1b[6~')
  assert.equal(resolveMobileTerminalActionInput('prtscr'), '\x1b[25~')
  assert.equal(resolveMobileTerminalActionInput('enter', { alt: true }), '\x1b\r')
  assert.equal(resolveMobileTerminalActionInput('ctrl+c'), '\x03')
  assert.equal(resolveMobileTerminalActionInput('ctrl+v'), '\x16')
  assert.equal(resolveMobileTerminalActionInput('ctrl+s'), '\x13')
})
