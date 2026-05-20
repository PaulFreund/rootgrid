import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAttachmentPayload, buildCodexInputItems } from '../src/server/sessionApiHelpers.js'

test('buildAttachmentPayload returns client-safe attachment descriptors', () => {
  const payload = buildAttachmentPayload([
    {
      uploadId: 'u-1',
      filename: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: 5,
      url: '/api/sessions/s-1/uploads/u-1',
      hostPath: '/tmp/secret',
      runnerPath: '/runner/secret'
    }
  ])

  assert.deepEqual(payload, [{
    uploadId: 'u-1',
    filename: 'note.txt',
    mimeType: 'text/plain',
    sizeBytes: 5,
    url: '/api/sessions/s-1/uploads/u-1'
  }])
})

test('buildCodexInputItems includes file list in text and image items separately', () => {
  const uploads = [
    { filename: 'report.txt', mimeType: 'text/plain', runnerPath: '/runner/report.txt' },
    { filename: 'diagram.png', mimeType: 'image/png', runnerPath: '/runner/diagram.png' }
  ]

  const items = buildCodexInputItems({
    text: 'please analyze',
    uploads,
    isImageMimeType: (mimeType) => String(mimeType).startsWith('image/')
  })

  assert.deepEqual(items, [
    {
      type: 'text',
      text: 'please analyze\n\n[Uploaded files]\n- report.txt: /runner/report.txt'
    },
    {
      type: 'localImage',
      path: '/runner/diagram.png'
    }
  ])
})

test('buildCodexInputItems falls back to attachment placeholder when text is empty', () => {
  const items = buildCodexInputItems({
    text: '',
    uploads: [{ filename: 'photo.jpg', mimeType: 'image/jpeg', runnerPath: '/runner/photo.jpg' }],
    isImageMimeType: (mimeType) => String(mimeType).startsWith('image/')
  })

  assert.equal(items[0].text, '(see attachments)')
})
