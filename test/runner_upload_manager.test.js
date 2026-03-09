import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RunnerUploadManager, safeRunnerUploadFilename } from '../src/runner/runnerUploadManager.js'

test('safeRunnerUploadFilename strips path separators and control characters', () => {
  assert.equal(safeRunnerUploadFilename('../a/b\0c.txt'), '.._a_bc.txt')
  assert.equal(safeRunnerUploadFilename('   '), 'upload')
})

test('RunnerUploadManager streams chunked uploads and emits uploaded metadata', async (t) => {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-uploads-'))
  t.after(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  const emitted = []
  const manager = new RunnerUploadManager({
    machineId: 'machine-1',
    uploadsDir,
    emit: (type, scope, payload) => emitted.push({ type, scope, payload })
  })

  await manager.begin({
    sessionId: 'session-1',
    uploadId: 'upload-1',
    filename: 'folder/example.txt',
    mimeType: 'text/plain'
  })
  await manager.chunk({
    sessionId: 'session-1',
    uploadId: 'upload-1',
    chunkBase64: Buffer.from('hello ').toString('base64')
  })
  await manager.chunk({
    sessionId: 'session-1',
    uploadId: 'upload-1',
    chunkBase64: Buffer.from('world').toString('base64')
  })
  await manager.end({
    sessionId: 'session-1',
    uploadId: 'upload-1'
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'session.uploaded')
  assert.equal(emitted[0].payload.filename, 'folder_example.txt')
  assert.equal(emitted[0].payload.sizeBytes, 11)
  assert.equal(await readFile(emitted[0].payload.path, 'utf8'), 'hello world')
})

test('RunnerUploadManager preserves begin/chunk/end order when host messages arrive back-to-back', async (t) => {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-uploads-'))
  t.after(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  const emitted = []
  const manager = new RunnerUploadManager({
    machineId: 'machine-1',
    uploadsDir,
    emit: (type, scope, payload) => emitted.push({ type, scope, payload })
  })

  const beginP = manager.begin({
    sessionId: 'session-race',
    uploadId: 'upload-race',
    filename: 'photo.png',
    mimeType: 'image/png'
  })
  const chunkP = manager.chunk({
    sessionId: 'session-race',
    uploadId: 'upload-race',
    chunkBase64: Buffer.from('abc123').toString('base64')
  })
  const endP = manager.end({
    sessionId: 'session-race',
    uploadId: 'upload-race'
  })

  await Promise.all([beginP, chunkP, endP])

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'session.uploaded')
  assert.equal(await readFile(emitted[0].payload.path, 'utf8'), 'abc123')
})

test('RunnerUploadManager writes full multi-chunk files beyond 64KB', async (t) => {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-uploads-'))
  t.after(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  const emitted = []
  const manager = new RunnerUploadManager({
    machineId: 'machine-1',
    uploadsDir,
    emit: (type, scope, payload) => emitted.push({ type, scope, payload })
  })

  const original = Buffer.alloc(200_000, 0x62)
  await manager.begin({
    sessionId: 'session-big',
    uploadId: 'upload-big',
    filename: 'big.bin',
    mimeType: 'application/octet-stream'
  })
  await manager.chunk({
    sessionId: 'session-big',
    uploadId: 'upload-big',
    chunkBase64: original.subarray(0, 65_536).toString('base64')
  })
  await manager.chunk({
    sessionId: 'session-big',
    uploadId: 'upload-big',
    chunkBase64: original.subarray(65_536, 131_072).toString('base64')
  })
  await manager.chunk({
    sessionId: 'session-big',
    uploadId: 'upload-big',
    chunkBase64: original.subarray(131_072).toString('base64')
  })
  await manager.end({
    sessionId: 'session-big',
    uploadId: 'upload-big'
  })

  const stored = await readFile(emitted[0].payload.path)
  assert.equal(stored.length, original.length)
  assert.deepEqual(stored, original)
})

test('RunnerUploadManager cleanupSession removes partial files and session directory', async (t) => {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-uploads-'))
  t.after(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  const manager = new RunnerUploadManager({
    machineId: 'machine-1',
    uploadsDir,
    emit: () => {}
  })

  await manager.begin({
    sessionId: 'session-2',
    uploadId: 'upload-2',
    filename: 'image.png',
    mimeType: 'image/png'
  })
  await manager.chunk({
    sessionId: 'session-2',
    uploadId: 'upload-2',
    chunkBase64: Buffer.from('partial-data').toString('base64')
  })

  const sessionDir = join(uploadsDir, 'session-2')
  await mkdir(sessionDir, { recursive: true })
  await manager.cleanupSession('session-2')

  await assert.rejects(readFile(join(sessionDir, 'upload-2-image.png')))
})
