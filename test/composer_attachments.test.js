import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildComposerAttachmentRefs,
  buildComposerAttachments,
  clearComposerAttachments,
  uploadComposerAttachments
} from '../web/src/lib/composerAttachments.js'

test('buildComposerAttachments creates previews for images and reports oversized files', () => {
  const createdPreviews = []
  const fileOk = { name: 'photo.png', size: 3, type: 'image/png' }
  const fileLarge = { name: 'movie.mp4', size: (50 * 1024 * 1024) + 1, type: 'video/mp4' }

  const out = buildComposerAttachments([fileOk, fileLarge], {
    createId: () => 'att-1',
    createPreviewUrl: (file) => {
      createdPreviews.push(file.name)
      return `blob:${file.name}`
    }
  })

  assert.equal(out.added.length, 1)
  assert.equal(out.added[0].id, 'att-1')
  assert.equal(out.added[0].previewUrl, 'blob:photo.png')
  assert.deepEqual(createdPreviews, ['photo.png'])
  assert.deepEqual(out.errors, ['File too large: movie.mp4 (max 50MB)'])
})

test('clearComposerAttachments revokes blob previews and empties the list', () => {
  const revoked = []
  const list = [
    { id: 'a', previewUrl: 'blob:one' },
    { id: 'b', previewUrl: 'https://example.test/two' },
    { id: 'c', previewUrl: 'blob:three' }
  ]

  clearComposerAttachments(list, {
    revokeObjectURL: (url) => revoked.push(url)
  })

  assert.deepEqual(revoked, ['blob:one', 'blob:three'])
  assert.equal(list.length, 0)
})

test('buildComposerAttachmentRefs restores reusable upload refs for the composer', () => {
  const restored = buildComposerAttachmentRefs([
    {
      uploadId: 'upload-1',
      filename: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 42,
      url: '/api/sessions/session-1/uploads/upload-1'
    },
    {
      uploadId: 'upload-2',
      filename: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      url: '/api/sessions/session-1/uploads/upload-2'
    }
  ], 'session-1', {
    createId: (() => {
      let next = 0
      return () => `att-${++next}`
    })()
  })

  assert.deepEqual(restored, [
    {
      id: 'att-1',
      filename: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 42,
      file: null,
      previewUrl: '/api/sessions/session-1/uploads/upload-1',
      uploadId: 'upload-1',
      uploadedForSessionId: 'session-1'
    },
    {
      id: 'att-2',
      filename: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      file: null,
      previewUrl: null,
      uploadId: 'upload-2',
      uploadedForSessionId: 'session-1'
    }
  ])
})

test('uploadComposerAttachments reuses session-local upload refs and uploads missing files', async () => {
  const file = new Blob(['hello'], { type: 'text/plain' })
  const attachments = [
    {
      id: 'a',
      filename: 'cached.txt',
      mimeType: 'text/plain',
      file,
      uploadId: 'upload-existing',
      uploadedForSessionId: 'session-1'
    },
    {
      id: 'b',
      filename: 'new.txt',
      mimeType: 'text/plain',
      file
    }
  ]

  const requests = []
  const uploaded = await uploadComposerAttachments({
    sessionId: 'session-1',
    attachments,
    apiFetch: async (path, init) => {
      requests.push({ path, init })
      return {
        ok: true,
        status: 200,
        async json() {
          return { uploadId: 'upload-new', filename: 'new.txt' }
        }
      }
    }
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/sessions/session-1/uploads?filename=new.txt')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.body, file)
  assert.deepEqual(uploaded, [
    { uploadId: 'upload-existing' },
    { uploadId: 'upload-new', filename: 'new.txt' }
  ])
  assert.equal(attachments[1].uploadId, 'upload-new')
  assert.equal(attachments[1].uploadedForSessionId, 'session-1')
})
