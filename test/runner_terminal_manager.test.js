import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

import {
  RunnerTerminalManager,
  appendTerminalOutput,
  normalizeTerminalSize
} from '../src/runner/runnerTerminalManager.js'

class FakePty {
  constructor(file, args, options) {
    this.file = file
    this.args = args
    this.options = options
    this.dataHandlers = []
    this.exitHandlers = []
    this.writes = []
    this.resizeCalls = []
    this.killed = false
  }

  onData(handler) {
    this.dataHandlers.push(handler)
  }

  onExit(handler) {
    this.exitHandlers.push(handler)
  }

  write(data) {
    this.writes.push(String(data ?? ''))
  }

  resize(cols, rows) {
    this.resizeCalls.push([cols, rows])
  }

  kill() {
    this.killed = true
  }

  emitData(data) {
    for (const handler of this.dataHandlers) handler(String(data ?? ''))
  }

  emitExit(event) {
    for (const handler of this.exitHandlers) handler(event ?? {})
  }
}

test('normalizeTerminalSize clamps values and appendTerminalOutput keeps capped tail', () => {
  assert.deepEqual(normalizeTerminalSize(null, null), { cols: 80, rows: 24 })
  assert.deepEqual(normalizeTerminalSize(8, 2), { cols: 20, rows: 5 })
  assert.deepEqual(normalizeTerminalSize(999, 999), { cols: 400, rows: 200 })
  assert.equal(appendTerminalOutput('abcdef', 'ghij', 8), 'cdefghij')
})

test('RunnerTerminalManager starts PTYs and proxies input, resize, output, and exit', async () => {
  const emitted = []
  let created = null
  const manager = new RunnerTerminalManager({
    machineId: 'machine-1',
    emit(type, payload) {
      emitted.push({ type, payload })
    },
    createPty(file, args, options) {
      created = new FakePty(file, args, options)
      return created
    }
  })

  await manager.start({
    requestId: 'req-1',
    terminalId: 'terminal-1',
    cwd: tmpdir(),
    cols: 120,
    rows: 40
  })

  assert.ok(created)
  assert.equal(created.options.cwd, tmpdir())
  assert.equal(created.options.cols, 120)
  assert.equal(created.options.rows, 40)
  assert.equal(emitted[0]?.type, 'terminal.pty.start.result')
  assert.equal(emitted[0]?.payload?.requestId, 'req-1')
  assert.equal(emitted[0]?.payload?.terminalId, 'terminal-1')

  manager.input({ terminalId: 'terminal-1', data: 'ls -la\n' })
  assert.deepEqual(created.writes, ['ls -la\n'])

  manager.resize({ terminalId: 'terminal-1', cols: 132, rows: 36 })
  assert.deepEqual(created.resizeCalls, [[132, 36]])

  created.emitData('hello world\n')
  assert.equal(emitted[1]?.type, 'terminal.pty.output')
  assert.equal(emitted[1]?.payload?.terminalId, 'terminal-1')
  assert.equal(emitted[1]?.payload?.data, 'hello world\n')

  created.emitExit({ exitCode: 7, signal: 15 })
  assert.equal(emitted[2]?.type, 'terminal.pty.exit')
  assert.equal(emitted[2]?.payload?.exitCode, 7)
  assert.equal(emitted[2]?.payload?.signal, 15)

  assert.equal(manager.close({ terminalId: 'terminal-1' }), false)
})

test('RunnerTerminalManager close kills the PTY and removes the terminal', async () => {
  let created = null
  const manager = new RunnerTerminalManager({
    machineId: 'machine-1',
    emit() {},
    createPty(file, args, options) {
      created = new FakePty(file, args, options)
      return created
    }
  })

  await manager.start({
    requestId: 'req-2',
    terminalId: 'terminal-2',
    cwd: tmpdir(),
    cols: 80,
    rows: 24
  })

  assert.equal(manager.close({ terminalId: 'terminal-2' }), true)
  assert.equal(created.killed, true)
})
