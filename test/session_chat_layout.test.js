import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSessionChatShellStyle,
  SESSION_CHAT_HEADER_MENU_MAX_WIDTH,
  SESSION_CHAT_MAX_WIDTH,
  shouldUseSessionChatHeaderMenu
} from '../web/src/lib/sessionChatLayout.js'

test('buildSessionChatShellStyle returns the normalized chat shell width', () => {
  assert.deepEqual(buildSessionChatShellStyle(), { maxWidth: '800px' })
  assert.deepEqual(buildSessionChatShellStyle(812.6), { maxWidth: '813px' })
  assert.deepEqual(buildSessionChatShellStyle('bad'), { maxWidth: '800px' })
})

test('shouldUseSessionChatHeaderMenu switches to the compact menu once the centered shell is exhausted', () => {
  assert.equal(SESSION_CHAT_MAX_WIDTH, 800)
  assert.equal(shouldUseSessionChatHeaderMenu(SESSION_CHAT_HEADER_MENU_MAX_WIDTH + 1), false)
  assert.equal(shouldUseSessionChatHeaderMenu(SESSION_CHAT_HEADER_MENU_MAX_WIDTH), true)
  assert.equal(shouldUseSessionChatHeaderMenu(700), true)
  assert.equal(shouldUseSessionChatHeaderMenu('bad'), false)
})
