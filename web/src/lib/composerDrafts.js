export const NEW_THREAD_COMPOSER_DRAFT_KEY = '__new_thread__'

export function composerDraftKeyForSession(sessionId) {
  const sid = String(sessionId ?? '').trim()
  return sid || NEW_THREAD_COMPOSER_DRAFT_KEY
}

export function getOrCreateComposerDraft(drafts, draftKey, {
  createDraft = () => ({ text: '', attachments: [] })
} = {}) {
  if (!(drafts instanceof Map)) throw new TypeError('drafts must be a Map')
  const key = String(draftKey ?? '').trim() || NEW_THREAD_COMPOSER_DRAFT_KEY
  const existing = drafts.get(key)
  if (existing && typeof existing === 'object') return existing
  const created = createDraft()
  drafts.set(key, created)
  return created
}

export function deleteComposerDraft(drafts, draftKey, {
  clearComposerAttachments = null
} = {}) {
  if (!(drafts instanceof Map)) return false
  const key = String(draftKey ?? '').trim() || NEW_THREAD_COMPOSER_DRAFT_KEY
  const existing = drafts.get(key)
  if (!existing) return false
  if (typeof clearComposerAttachments === 'function') {
    try { clearComposerAttachments(existing.attachments) } catch {}
  }
  return drafts.delete(key)
}
