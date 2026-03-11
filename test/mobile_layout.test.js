import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MOBILE_LAYOUT_MAX_WIDTH,
  isMobileViewportWidth,
  preferredMobilePane,
  SESSION_CHAT_HEADER_MENU_MAX_WIDTH,
  SESSION_CHAT_MAX_WIDTH,
  shouldUseSessionChatHeaderMenu
} from '../web/src/lib/mobileLayout.js'

test('isMobileViewportWidth detects narrow layouts only', () => {
  assert.equal(isMobileViewportWidth(0), false)
  assert.equal(isMobileViewportWidth(420), true)
  assert.equal(isMobileViewportWidth(MOBILE_LAYOUT_MAX_WIDTH), true)
  assert.equal(isMobileViewportWidth(MOBILE_LAYOUT_MAX_WIDTH + 1), false)
  assert.equal(isMobileViewportWidth('bad'), false)
})

test('preferredMobilePane opens the session pane only when a session is selected', () => {
  assert.equal(preferredMobilePane(null), 'list')
  assert.equal(preferredMobilePane(''), 'list')
  assert.equal(preferredMobilePane('session-1'), 'session')
})

test('shouldUseSessionChatHeaderMenu switches to the compact menu once the centered shell is exhausted', () => {
  assert.equal(SESSION_CHAT_MAX_WIDTH, 800)
  assert.equal(shouldUseSessionChatHeaderMenu(SESSION_CHAT_HEADER_MENU_MAX_WIDTH + 1), false)
  assert.equal(shouldUseSessionChatHeaderMenu(SESSION_CHAT_HEADER_MENU_MAX_WIDTH), true)
  assert.equal(shouldUseSessionChatHeaderMenu(700), true)
  assert.equal(shouldUseSessionChatHeaderMenu('bad'), false)
})
