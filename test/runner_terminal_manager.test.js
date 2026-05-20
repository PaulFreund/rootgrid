import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import {
  RunnerTerminalManager,
  appendTerminalOutput,
  buildScriptSpawnSpec,
  buildTerminalResizeSpec,
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
    queueMicrotask(() => {
      this.emit('spawn')
      if (file === 'stty') this.emit('exit', 0, null)
    })
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

test('buildTerminalResizeSpec uses Linux and macOS stty flags', () => {
  assert.deepEqual(buildTerminalResizeSpec({
    ttyPath: '/dev/pts/4',
    cols: 132,
    rows: 36,
    platform: 'linux'
  }), {
    file: 'stty',
    args: ['cols', '132', 'rows', '36', '-F', '/dev/pts/4'],
    cols: 132,
    rows: 36
  })

  assert.deepEqual(buildTerminalResizeSpec({
    ttyPath: '/dev/ttys001',
    cols: 132,
    rows: 36,
    platform: 'darwin'
  }), {
    file: 'stty',
    args: ['cols', '132', 'rows', '36', '-f', '/dev/ttys001'],
    cols: 132,
    rows: 36
  })
})

test('RunnerTerminalManager starts script terminals and proxies input, output, and exit', async () => {
  const emitted = []
  const created = []
  const manager = new RunnerTerminalManager({
    machineId: 'machine-1',
    emit(type, payload) {
      emitted.push({ type, payload })
    },
    platform: 'linux',
    spawnProcess(file, args, options) {
      const child = new FakeChild(file, args, options)
      created.push(child)
      return child
    },
    makeTempDir: async () => tmpdir(),
    removePath: async () => {},
    readTextFile: async () => '123 /dev/pts/4\n'
  })

  await manager.start({
    requestId: 'req-1',
    terminalId: 'terminal-1',
    cwd: tmpdir(),
    cols: 120,
    rows: 40
  })

  assert.ok(created[0])
  assert.equal(created[0].file, 'script')
  assert.equal(created[0].options.cwd, tmpdir())
  assert.equal(created[0].options.env.COLUMNS, '120')
  assert.equal(emitted[0]?.type, 'terminal.pty.start.result')
  assert.equal(emitted[0]?.payload?.requestId, 'req-1')
  assert.equal(emitted[0]?.payload?.terminalId, 'terminal-1')

  manager.input({ terminalId: 'terminal-1', data: 'ls -la\n' })
  assert.deepEqual(created[0].stdin.writes, ['ls -la\n'])

  manager.resize({ terminalId: 'terminal-1', cols: 132, rows: 36 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(manager.terminals.get('terminal-1')?.cols, 132)
  assert.equal(manager.terminals.get('terminal-1')?.rows, 36)
  assert.equal(created[1]?.file, 'stty')
  assert.deepEqual(created[1]?.args, ['cols', '132', 'rows', '36', '-F', '/dev/pts/4'])

  created[0].stdout.emit('data', 'hello ')
  created[0].stdout.emit('data', 'world\n')
  await new Promise((resolve) => setTimeout(resolve, 12))
  assert.equal(emitted[1]?.type, 'terminal.pty.output')
  assert.equal(emitted[1]?.payload?.terminalId, 'terminal-1')
  assert.equal(emitted[1]?.payload?.data, 'hello world\n')

  created[0].stderr.emit('data', 'warning\n')
  await new Promise((resolve) => setTimeout(resolve, 12))
  assert.equal(emitted[2]?.type, 'terminal.pty.output')
  assert.equal(emitted[2]?.payload?.data, 'warning\n')

  created[0].emit('exit', 7, 15)
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
    },
    makeTempDir: async () => tmpdir(),
    removePath: async () => {},
    readTextFile: async () => '123 /dev/pts/4\n'
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

test('RunnerTerminalManager resize signals the active shell after updating tty size', async () => {
  const signalCalls = []
  const created = []
  const manager = new RunnerTerminalManager({
    machineId: 'machine-1',
    emit() {},
    platform: 'linux',
    signalProcess(pid, signal) {
      signalCalls.push([pid, signal])
    },
    spawnProcess(file, args, options) {
      const child = new FakeChild(file, args, options)
      created.push(child)
      return child
    },
    makeTempDir: async () => tmpdir(),
    removePath: async () => {},
    readTextFile: async () => '987 /dev/pts/9\n'
  })

  await manager.start({
    requestId: 'req-3',
    terminalId: 'terminal-3',
    cwd: tmpdir(),
    cols: 80,
    rows: 24
  })

  manager.resize({ terminalId: 'terminal-3', cols: 110, rows: 32 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(created[1]?.args, ['cols', '110', 'rows', '32', '-F', '/dev/pts/9'])
  assert.deepEqual(signalCalls, [[987, 'SIGWINCH']])
})
