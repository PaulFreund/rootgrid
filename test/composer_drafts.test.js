import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref } from 'vue'

import {
  NEW_THREAD_COMPOSER_DRAFT_KEY,
  composerDraftKeyForSession,
  deleteComposerDraft,
  getOrCreateComposerDraft
} from '../web/src/lib/composerDrafts.js'

test('composerDraftKeyForSession uses a stable new-thread key', () => {
  assert.equal(composerDraftKeyForSession('session-1'), 'session-1')
  assert.equal(composerDraftKeyForSession(' session-2 '), 'session-2')
  assert.equal(composerDraftKeyForSession(''), NEW_THREAD_COMPOSER_DRAFT_KEY)
  assert.equal(composerDraftKeyForSession(null), NEW_THREAD_COMPOSER_DRAFT_KEY)
})

test('getOrCreateComposerDraft reuses existing draft records', () => {
  const drafts = new Map()
  const created = getOrCreateComposerDraft(drafts, 'session-1', {
    createDraft: () => ({ text: 'draft text', attachments: ['a'] })
  })
  const reused = getOrCreateComposerDraft(drafts, 'session-1')

  assert.equal(reused, created)
  assert.deepEqual(reused, { text: 'draft text', attachments: ['a'] })
})

test('deleteComposerDraft clears attachment previews before removing the draft', () => {
  const drafts = new Map([
    ['session-1', { text: 'keep me', attachments: [{ id: 'a' }, { id: 'b' }] }]
  ])
  const cleared = []

  const removed = deleteComposerDraft(drafts, 'session-1', {
    clearComposerAttachments: (attachments) => {
      cleared.push(...attachments.map((attachment) => attachment.id))
      attachments.splice(0, attachments.length)
    }
  })

  assert.equal(removed, true)
  assert.deepEqual(cleared, ['a', 'b'])
  assert.equal(drafts.has('session-1'), false)
})

test('per-session composer draft state survives switching between sessions', () => {
  const drafts = new Map()
  const selectedSessionId = ref('session-1')
  const createDraft = () => reactive({ text: '', attachments: [] })
  const getDraft = (sessionId = selectedSessionId.value) => {
    return getOrCreateComposerDraft(drafts, composerDraftKeyForSession(sessionId), { createDraft })
  }

  const messageDraft = computed({
    get: () => getDraft().text,
    set: (value) => { getDraft().text = String(value ?? '') }
  })
  const attachments = computed({
    get: () => getDraft().attachments,
    set: (value) => { getDraft().attachments = Array.isArray(value) ? value : [] }
  })

  messageDraft.value = 'first session draft'
  attachments.value.push({ id: 'att-1', filename: 'one.txt' })

  selectedSessionId.value = 'session-2'
  assert.equal(messageDraft.value, '')
  assert.equal(attachments.value.length, 0)

  messageDraft.value = 'second session draft'
  attachments.value.push({ id: 'att-2', filename: 'two.txt' })

  selectedSessionId.value = 'session-1'
  assert.equal(messageDraft.value, 'first session draft')
  assert.deepEqual(attachments.value.map((attachment) => attachment.filename), ['one.txt'])

  selectedSessionId.value = null
  assert.equal(messageDraft.value, '')
  attachments.value.push({ id: 'att-3', filename: 'three.txt' })

  selectedSessionId.value = 'session-2'
  assert.equal(messageDraft.value, 'second session draft')
  assert.deepEqual(attachments.value.map((attachment) => attachment.filename), ['two.txt'])
})
