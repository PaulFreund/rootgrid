import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUploadService } from '../src/server/uploads.js'

test('upload service rejects pending runner uploads immediately on runner disconnect', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-upload-service-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const hostPath = join(dir, 'sample.txt')
  await writeFile(hostPath, 'hello world', 'utf8')

  const envelopes = []
  const service = createUploadService({
    runnerWs: {
      sendToMachine(machineId, envelope) {
        envelopes.push({ machineId, envelope })
        return true
      }
    },
    store: {
      deleteUpload() {}
    },
    makeEnvelope(input) {
      return input
    },
    httpError(statusCode, message) {
      const err = new Error(message)
      err.statusCode = statusCode
      return err
    }
  })

  const uploadP = service.uploadToRunnerFromFile({
    machineId: 'machine-1',
    sessionId: 'session-1',
    uploadId: 'upload-1',
    filename: 'sample.txt',
    mimeType: 'text/plain',
    hostPath
  })

  const rejectionP = uploadP.then(
    () => {
      throw new Error('expected upload to reject')
    },
    (err) => err
  )
  service.handleRunnerDisconnect('machine-1')

  const err = await rejectionP
  assert.match(String(err?.message ?? err), /runner disconnected during upload/i)
  assert.equal(envelopes[0]?.envelope?.type, 'session.upload.begin')
})

test('upload service stores full multi-chunk request bodies on the host', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-upload-service-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const previousHome = process.env.ROOTGRID_HOME_DIR
  process.env.ROOTGRID_HOME_DIR = dir
  t.after(() => {
    if (previousHome === undefined) delete process.env.ROOTGRID_HOME_DIR
    else process.env.ROOTGRID_HOME_DIR = previousHome
  })

  const service = createUploadService({
    runnerWs: {
      sendToMachine() {
        return true
      }
    },
    store: {
      deleteUpload() {}
    },
    makeEnvelope(input) {
      return input
    },
    httpError(statusCode, message) {
      const err = new Error(message)
      err.statusCode = statusCode
      return err
    }
  })

  const original = Buffer.alloc(200_000, 0x61)
  const req = {
    headers: { 'content-length': String(original.length) },
    async *[Symbol.asyncIterator]() {
      yield original.subarray(0, 65_536)
      yield original.subarray(65_536, 131_072)
      yield original.subarray(131_072)
    }
  }

  const out = await service.storeHostUploadFromRequest({
    req,
    sessionId: 'session-1',
    uploadId: 'upload-1',
    filename: 'image.png',
    maxBytes: 50 * 1024 * 1024
  })

  const stored = await readFile(out.path)
  assert.equal(stored.length, original.length)
  assert.deepEqual(stored, original)
})
