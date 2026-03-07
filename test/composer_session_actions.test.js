import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'

import {
  buildComposerMessageBody,
  createComposerSessionActions
} from '../web/src/lib/composerSessionActions.js'

test('buildComposerMessageBody includes upload refs and preserves attachment-only messages', () => {
  assert.deepEqual(
    buildComposerMessageBody({
      text: '',
      uploadedAttachments: [
        { uploadId: 'upload-1' },
        { uploadId: '' },
        { uploadId: 'upload-2' }
      ]
    }),
    {
      text: '',
      attachments: [
        { uploadId: 'upload-1' },
        { uploadId: 'upload-2' }
      ]
    }
  )
})

test('createSessionFromDraft creates the draft session, uploads attachments, and sends the first message', async () => {
  const defaults = reactive({
    cwd: '/workspace/rootgrid',
    machineId: 'machine-1',
    model: 'gpt-5-codex',
    reasoningEffort: 'medium',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  })
  const defaultsError = ref('')
  const attachments = ref([
    {
      id: 'att-1',
      filename: 'note.txt',
      mimeType: 'text/plain',
      file: new Blob(['hello'], { type: 'text/plain' })
    }
  ])
  const composerDragging = ref(false)
  const fileInputEl = ref(null)
  const sendError = ref('')
  const messageDraft = ref('')
  const sending = ref(false)
  const selectedSession = ref(null)
  const selectedSessionId = ref(null)
  const requests = []

  const { createSessionFromDraft } = createComposerSessionActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/sessions/draft') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { sessionId: 'session-1' }
          }
        }
      }
      if (path === '/api/sessions/session-1/uploads?filename=note.txt') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { uploadId: 'upload-1', filename: 'note.txt' }
          }
        }
      }
      if (path === '/api/sessions/session-1/messages') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true }
          }
        }
      }
      throw new Error(`unexpected request: ${path}`)
    },
    defaults,
    defaultsError,
    openSettings: () => {},
    attachments,
    composerDragging,
    fileInputEl,
    sendError,
    messageDraft,
    sending,
    selectedSession,
    selectedSessionId
  })

  const sessionId = await createSessionFromDraft('Hello Rootgrid')

  assert.equal(sessionId, 'session-1')
  assert.equal(selectedSessionId.value, 'session-1')
  assert.equal(sendError.value, '')
  assert.equal(attachments.value.length, 0)
  assert.deepEqual(requests.map((req) => req.path), [
    '/api/sessions/draft',
    '/api/sessions/session-1/uploads?filename=note.txt',
    '/api/sessions/session-1/messages'
  ])
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    cwd: '/workspace/rootgrid',
    machineId: 'machine-1',
    options: {
      model: 'gpt-5-codex',
      reasoningEffort: 'medium',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }
  })
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    text: 'Hello Rootgrid',
    attachments: [{ uploadId: 'upload-1' }]
  })
})

test('submit cancels the running turn instead of sending another message', async () => {
  const requests = []

  const { submit } = createComposerSessionActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true } }
      }
    },
    defaults: reactive({
      cwd: '/workspace/rootgrid',
      machineId: '',
      model: '',
      reasoningEffort: '',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }),
    defaultsError: ref(''),
    openSettings: () => {},
    attachments: ref([]),
    composerDragging: ref(false),
    fileInputEl: ref(null),
    sendError: ref(''),
    messageDraft: ref('should-not-send'),
    sending: ref(false),
    selectedSession: ref({ turnState: 'running' }),
    selectedSessionId: ref('session-running')
  })

  await submit()

  assert.deepEqual(requests.map((req) => req.path), ['/api/sessions/session-running/cancel'])
  assert.equal(requests[0].init.method, 'POST')
})
