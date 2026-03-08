import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import {
  RunnerTerminalManager,
  appendTerminalOutput,
  buildScriptSpawnSpec,
  normalizeTerminalSize
} from '../src/runner/runnerTerminalManager.js'

class FakeStream extends EventEmitter {
  constructor() {
    super()
    this.writes = []
  }

  write(data) {
    this.writes.push(String(data ?? ''))
    return true
  }
}

class FakeChild extends EventEmitter {
  constructor(file, args, options) {
    super()
    this.file = file
    this.args = args
    this.options = options
    this.stdout = new FakeStream()
    this.stderr = new FakeStream()
    this.stdin = new FakeStream()
    this.killCalls = []
    queueMicrotask(() => this.emit('spawn'))
  }

  kill(signal) {
    this.killCalls.push(signal ?? null)
    return true
  }
}

test('normalizeTerminalSize clamps values and appendTerminalOutput keeps capped tail', () => {
  assert.deepEqual(normalizeTerminalSize(null, null), { cols: 80, rows: 24 })
  assert.deepEqual(normalizeTerminalSize(8, 2), { cols: 20, rows: 5 })
  assert.deepEqual(normalizeTerminalSize(999, 999), { cols: 400, rows: 200 })
  assert.equal(appendTerminalOutput('abcdef', 'ghij', 8), 'cdefghij')
})

test('buildScriptSpawnSpec uses util-linux script flags on Linux and BSD-style flags on macOS', () => {
  const linux = buildScriptSpawnSpec({
    shell: '/bin/bash',
    cwd: '/tmp/workspace',
    cols: 120,
    rows: 40,
    platform: 'linux'
  })
  assert.deepEqual(linux.args, [
    '-qefc',
    "stty cols 120 rows 40 >/dev/null 2>&1 || true; exec '/bin/bash' -i",
    '/dev/null'
  ])
  assert.equal(linux.cwd, '/tmp/workspace')
  assert.equal(linux.env.COLUMNS, '120')
  assert.equal(linux.env.LINES, '40')

  const darwin = buildScriptSpawnSpec({
    shell: '/bin/zsh',
    cwd: '/tmp/workspace',
    cols: 90,
    rows: 30,
    platform: 'darwin'
  })
  assert.deepEqual(darwin.args, [
    '-q',
    '/dev/null',
    '/bin/sh',
    '-lc',
    "stty cols 90 rows 30 >/dev/null 2>&1 || true; exec '/bin/zsh' -i"
  ])
})

test('RunnerTerminalManager starts script terminals and proxies input, output, and exit', async () => {
  const emitted = []
  let created = null
  const manager = new RunnerTerminalManager({
    machineId: 'machine-1',
    emit(type, payload) {
      emitted.push({ type, payload })
    },
    platform: 'linux',
    spawnProcess(file, args, options) {
      created = new FakeChild(file, args, options)
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
  assert.equal(created.file, 'script')
  assert.equal(created.options.cwd, tmpdir())
  assert.equal(created.options.env.COLUMNS, '120')
  assert.equal(emitted[0]?.type, 'terminal.pty.start.result')
  assert.equal(emitted[0]?.payload?.requestId, 'req-1')
  assert.equal(emitted[0]?.payload?.terminalId, 'terminal-1')

  manager.input({ terminalId: 'terminal-1', data: 'ls -la\n' })
  assert.deepEqual(created.stdin.writes, ['ls -la\n'])

  manager.resize({ terminalId: 'terminal-1', cols: 132, rows: 36 })
  assert.equal(manager.terminals.get('terminal-1')?.cols, 132)
  assert.equal(manager.terminals.get('terminal-1')?.rows, 36)

  created.stdout.emit('data', 'hello world\n')
  assert.equal(emitted[1]?.type, 'terminal.pty.output')
  assert.equal(emitted[1]?.payload?.terminalId, 'terminal-1')
  assert.equal(emitted[1]?.payload?.data, 'hello world\n')

  created.stderr.emit('data', 'warning\n')
  assert.equal(emitted[2]?.type, 'terminal.pty.output')
  assert.equal(emitted[2]?.payload?.data, 'warning\n')

  created.emit('exit', 7, 15)
  assert.equal(emitted[3]?.type, 'terminal.pty.exit')
  assert.equal(emitted[3]?.payload?.exitCode, 7)
  assert.equal(emitted[3]?.payload?.signal, 15)

  assert.equal(manager.close({ terminalId: 'terminal-1' }), false)
})

test('RunnerTerminalManager close kills the script process and removes the terminal', async () => {
  let created = null
  const manager = new RunnerTerminalManager({
    machineId: 'machine-1',
    emit() {},
    spawnProcess(file, args, options) {
      created = new FakeChild(file, args, options)
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
  assert.deepEqual(created.killCalls, ['SIGHUP'])
})
