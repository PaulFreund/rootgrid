import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MOBILE_LAYOUT_MAX_WIDTH,
  isMobileViewportWidth,
  preferredMobilePane
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
