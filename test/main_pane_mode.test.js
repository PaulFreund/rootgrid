import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveMainPaneMode,
  shouldAutoOpenNewThreadScreen
} from '../web/src/lib/mainPaneMode.js'

test('shouldAutoOpenNewThreadScreen stays disabled for bare app loads', () => {
  assert.equal(shouldAutoOpenNewThreadScreen({
    authed: true,
    suppressAutoNewThreadScreen: false,
    selectedSessionId: '',
    deepLinkSessionId: '',
    hasCompleteDefaultWorkspaceSelection: false,
    isMobileLayout: false,
    forceEmptyHomeScreen: false
  }), false)
})

test('resolveMainPaneMode prefers empty after delete and on bare app loads', () => {
  assert.equal(resolveMainPaneMode({
    newThreadOpen: false,
    defaultsOpen: false,
    authed: true,
    suppressAutoNewThreadScreen: true,
    selectedSessionId: '',
    deepLinkSessionId: '',
    hasCompleteDefaultWorkspaceSelection: false,
    isMobileLayout: false,
    forceEmptyHomeScreen: true
  }), 'empty')

  assert.equal(resolveMainPaneMode({
    newThreadOpen: false,
    defaultsOpen: false,
    authed: true,
    suppressAutoNewThreadScreen: false,
    selectedSessionId: '',
    deepLinkSessionId: '',
    hasCompleteDefaultWorkspaceSelection: false,
    isMobileLayout: true,
    forceEmptyHomeScreen: false
  }), 'empty')

  assert.equal(resolveMainPaneMode({
    newThreadOpen: false,
    defaultsOpen: false,
    authed: true,
    suppressAutoNewThreadScreen: false,
    selectedSessionId: '',
    deepLinkSessionId: '',
    hasCompleteDefaultWorkspaceSelection: true,
    isMobileLayout: false,
    forceEmptyHomeScreen: false
  }), 'empty')

  assert.equal(resolveMainPaneMode({
    newThreadOpen: false,
    defaultsOpen: false,
    authed: true,
    suppressAutoNewThreadScreen: false,
    selectedSessionId: '',
    deepLinkSessionId: '',
    hasCompleteDefaultWorkspaceSelection: false,
    isMobileLayout: false,
    forceEmptyHomeScreen: false
  }), 'empty')
})
