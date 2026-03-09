import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'

import {
  buildComposerMessageBody,
  createComposerSessionActions
} from '../web/src/lib/composerSessionActions.js'
import { createSessionStoreState } from '../web/src/lib/sessionUi.js'

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

test('submit queues a follow-up while the selected session is running', async () => {
  const sessionStores = reactive(new Map([['session-running', createSessionStoreState()]]))
  const attachments = ref([
    {
      id: 'att-1',
      filename: 'note.txt',
      mimeType: 'text/plain',
      file: new Blob(['hello'], { type: 'text/plain' })
    }
  ])
  const requests = []

  const { submit } = createComposerSessionActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/sessions/session-running/uploads?filename=note.txt') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { uploadId: 'upload-1', filename: 'note.txt' }
          }
        }
      }
      if (path === '/api/sessions/session-running/queued-prompts') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              promptId: 'queued-1',
              queuedPrompts: [{
                id: 'queued-1',
                promptId: 'queued-1',
                text: 'queue this next',
                attachments: [{ uploadId: 'upload-1', filename: 'note.txt', url: '/api/sessions/session-running/uploads/upload-1' }],
                createdAtMs: 1,
                updatedAtMs: 1
              }]
            }
          }
        }
      }
      throw new Error(`unexpected request: ${path}`)
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
    attachments,
    composerDragging: ref(false),
    fileInputEl: ref(null),
    sendError: ref(''),
    messageDraft: ref('queue this next'),
    sending: ref(false),
    getSessionStore(sessionId) {
      return sessionStores.get(sessionId)
    },
    selectedSession: ref({ turnState: 'running' }),
    selectedSessionId: ref('session-running')
  })

  await submit()

  const store = sessionStores.get('session-running')
  assert.equal(store.queuedPrompts.length, 1)
  assert.equal(store.queuedPrompts[0].text, 'queue this next')
  assert.equal(store.queuedPrompts[0].attachments.length, 1)
  assert.equal(attachments.value.length, 0)
  assert.deepEqual(requests.map((req) => req.path), [
    '/api/sessions/session-running/uploads?filename=note.txt',
    '/api/sessions/session-running/queued-prompts'
  ])
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    text: 'queue this next',
    attachments: [{ uploadId: 'upload-1' }]
  })
})

test('submit cancels the running turn instead of sending another message when no follow-up draft exists', async () => {
  const requests = []
  const sessionStores = reactive(new Map([['session-running', createSessionStoreState()]]))

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
    messageDraft: ref(''),
    sending: ref(false),
    getSessionStore(sessionId) {
      return sessionStores.get(sessionId)
    },
    selectedSession: ref({ turnState: 'running' }),
    selectedSessionId: ref('session-running')
  })

  await submit()

  assert.deepEqual(requests.map((req) => req.path), ['/api/sessions/session-running/cancel'])
  assert.equal(requests[0].init.method, 'POST')
})

test('queued prompt actions persist edits, steer, and delete via the backend', async () => {
  const sessionStores = reactive(new Map([['session-1', createSessionStoreState()]]))
  sessionStores.get('session-1').queuedPrompts.push({
    id: 'queued-1',
    promptId: 'queued-1',
    text: 'ship it',
    attachments: [],
    createdAtMs: 1
  })
  const requests = []

  const {
    updateQueuedPromptText,
    sendQueuedPromptNow,
    removeQueuedPrompt
  } = createComposerSessionActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/sessions/session-1/queued-prompts/queued-1' && init.method === 'PATCH') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              queuedPrompts: [{
                id: 'queued-1',
                promptId: 'queued-1',
                text: 'ship it later',
                attachments: [],
                createdAtMs: 1,
                updatedAtMs: 2
              }]
            }
          }
        }
      }
      if (path === '/api/sessions/session-1/queued-prompts/queued-1/send' && init.method === 'POST') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, queuedPrompts: [] }
          }
        }
      }
      if (path === '/api/sessions/session-1/queued-prompts/queued-1' && init.method === 'DELETE') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, queuedPrompts: [] }
          }
        }
      }
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
    messageDraft: ref(''),
    sending: ref(false),
    getSessionStore(sessionId) {
      return sessionStores.get(sessionId)
    },
    selectedSession: ref({ turnState: 'idle' }),
    selectedSessionId: ref('session-1')
  })

  const saved = await updateQueuedPromptText('session-1', 'queued-1', 'ship it later')
  assert.equal(saved, true)
  assert.equal(sessionStores.get('session-1').queuedPrompts[0].text, 'ship it later')

  const sent = await sendQueuedPromptNow('session-1', 'queued-1')
  assert.equal(sent, true)
  assert.equal(sessionStores.get('session-1').queuedPrompts.length, 0)

  sessionStores.get('session-1').queuedPrompts = [{
    id: 'queued-1',
    promptId: 'queued-1',
    text: 'delete me',
    attachments: [],
    createdAtMs: 3
  }]
  const removed = await removeQueuedPrompt('session-1', 'queued-1')
  assert.equal(removed, true)
  assert.equal(sessionStores.get('session-1').queuedPrompts.length, 0)
  assert.deepEqual(requests.map((req) => [req.path, req.init.method ?? 'GET']), [
    ['/api/sessions/session-1/queued-prompts/queued-1', 'PATCH'],
    ['/api/sessions/session-1/queued-prompts/queued-1/send', 'POST'],
    ['/api/sessions/session-1/queued-prompts/queued-1', 'DELETE']
  ])
})
