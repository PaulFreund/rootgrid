import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_DESKTOP_SIDEBAR_MODE,
  DEFAULT_SESSION_SIDEBAR_SIDE,
  clampSessionSidebarWidth,
  DEFAULT_SESSION_SIDEBAR_WIDTH,
  normalizeDesktopSidebarMode,
  normalizeSessionSidebarSide,
  persistDesktopSidebarMode,
  persistSessionSidebarSide,
  persistSessionSidebarWidth,
  readStoredDesktopSidebarMode,
  readStoredSessionSidebarSide,
  readStoredSessionSidebarWidth
} from '../web/src/lib/sidebarResize.js'

test('clampSessionSidebarWidth keeps the session sidebar within min/max bounds', () => {
  assert.equal(clampSessionSidebarWidth(50, 1200), 220)
  assert.equal(clampSessionSidebarWidth(999, 1200), 420)
  assert.equal(clampSessionSidebarWidth(999, 500), 225)
  assert.equal(clampSessionSidebarWidth('bad', 1200), DEFAULT_SESSION_SIDEBAR_WIDTH)
})

test('stored session sidebar width is read and persisted safely', () => {
  const values = new Map()
  const storage = {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    }
  }

  assert.equal(readStoredSessionSidebarWidth(storage, 900), DEFAULT_SESSION_SIDEBAR_WIDTH)
  const width = persistSessionSidebarWidth(312, storage)
  assert.equal(width, 312)
  assert.equal(values.get('rootgrid.sessionSidebarWidth'), '312')
  assert.equal(readStoredSessionSidebarWidth(storage, 900), 312)

  values.set('rootgrid.sessionSidebarWidth', '169')
  assert.equal(readStoredSessionSidebarWidth(storage, 900), DEFAULT_SESSION_SIDEBAR_WIDTH)
})

test('desktop sidebar mode is normalized and persisted safely', () => {
  const values = new Map()
  const storage = {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    }
  }

  assert.equal(normalizeDesktopSidebarMode('hover'), 'hover')
  assert.equal(normalizeDesktopSidebarMode('COLLAPSED'), 'collapsed')
  assert.equal(normalizeDesktopSidebarMode('bad'), DEFAULT_DESKTOP_SIDEBAR_MODE)
  assert.equal(readStoredDesktopSidebarMode(storage), DEFAULT_DESKTOP_SIDEBAR_MODE)
  assert.equal(persistDesktopSidebarMode('hover', storage), 'hover')
  assert.equal(values.get('rootgrid.desktopSidebarMode'), 'hover')
  values.set('rootgrid.desktopSidebarMode', 'collapsed')
  assert.equal(readStoredDesktopSidebarMode(storage), 'collapsed')
})

test('session sidebar side is normalized and persisted safely', () => {
  const values = new Map()
  const storage = {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    }
  }

  assert.equal(normalizeSessionSidebarSide('right'), 'right')
  assert.equal(normalizeSessionSidebarSide('LEFT'), 'left')
  assert.equal(normalizeSessionSidebarSide('bad'), DEFAULT_SESSION_SIDEBAR_SIDE)
  assert.equal(readStoredSessionSidebarSide(storage), DEFAULT_SESSION_SIDEBAR_SIDE)
  assert.equal(persistSessionSidebarSide('right', storage), 'right')
  assert.equal(values.get('rootgrid.sessionSidebarSide'), 'right')
  values.set('rootgrid.sessionSidebarSide', 'left')
  assert.equal(readStoredSessionSidebarSide(storage), 'left')
})
