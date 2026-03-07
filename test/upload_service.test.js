import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
