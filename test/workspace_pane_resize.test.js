import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_WORKSPACE_CHAT_WIDTH,
  clampWorkspaceChatWidth,
  persistWorkspaceChatWidth,
  readStoredWorkspaceChatWidth
} from '../web/src/lib/workspacePaneResize.js'

test('clampWorkspaceChatWidth keeps the chat pane within min/max bounds', () => {
  assert.equal(clampWorkspaceChatWidth(100, 1200), 320)
  assert.equal(clampWorkspaceChatWidth(9999, 1200), 1188)
  assert.equal(clampWorkspaceChatWidth(9999, 800), 788)
  assert.equal(clampWorkspaceChatWidth('bad', 1200), DEFAULT_WORKSPACE_CHAT_WIDTH)
})

test('stored workspace pane width is read and persisted safely', () => {
  const values = new Map()
  const storage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, String(value))
    }
  }

  assert.equal(readStoredWorkspaceChatWidth(storage, 1200), DEFAULT_WORKSPACE_CHAT_WIDTH)
  const width = persistWorkspaceChatWidth(512, storage)
  assert.equal(width, 512)
  assert.equal(values.get('rootgrid.workspaceChatWidth'), '512')
  assert.equal(readStoredWorkspaceChatWidth(storage, 1200), 512)
})
