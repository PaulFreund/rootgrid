import test from 'node:test'
import assert from 'node:assert/strict'

import {
  copyTextToClipboard,
  dismissToastById,
  replaceUrlSessionParam,
  scheduleToastDismiss,
  showBrowserNotification
} from '../web/src/lib/browserUi.js'

test('replaceUrlSessionParam updates the current URL search params', () => {
  let replaced = null
  const ok = replaceUrlSessionParam('session-1', {
    windowObj: {
      location: { href: 'http://127.0.0.1:7337/?foo=bar' },
      history: {
        replaceState(_state, _title, nextUrl) {
          replaced = nextUrl
        }
      }
    }
  })

  assert.equal(ok, true)
  assert.match(String(replaced), /session=session-1/)
})

test('toast helpers dismiss and schedule removal', () => {
  const toasts = [{ id: 'a' }, { id: 'b' }]
  assert.equal(dismissToastById(toasts, 'a'), true)
  assert.deepEqual(toasts, [{ id: 'b' }])

  let calledWith = null
  const timer = scheduleToastDismiss({
    id: 'b',
    dismiss: (id) => { calledWith = id },
    ms: 123,
    setTimeoutFn(fn, _ms) {
      fn()
      return { unref() {} }
    }
  })
  assert.ok(timer)
  assert.equal(calledWith, 'b')
})

test('showBrowserNotification opens the selected session on click', () => {
  const created = []
  class FakeNotification {
    constructor(title, opts) {
      this.title = title
      this.opts = opts
      created.push(this)
    }

    close() {
      this.closed = true
    }
  }

  let focused = false
  let selected = null
  const shown = showBrowserNotification({
    notificationSupported: true,
    permission: 'granted',
    toast: { title: 'Rootgrid', message: 'Done', sessionId: 'session-1', notificationKey: 'turn:session-1:turn-1' },
    NotificationCtor: FakeNotification,
    focusWindow: () => { focused = true },
    onSessionSelected: (sid) => { selected = sid }
  })

  assert.equal(shown, true)
  assert.equal(created.length, 1)
  assert.equal(created[0].opts?.tag, 'turn:session-1:turn-1')
  created[0].onclick()
  assert.equal(focused, true)
  assert.equal(selected, 'session-1')
  assert.equal(created[0].closed, true)
})

test('copyTextToClipboard prefers navigator clipboard and falls back to execCommand', async () => {
  const clipboardWrites = []
  const ok = await copyTextToClipboard('hello', {
    navigatorObj: {
      clipboard: {
        async writeText(value) {
          clipboardWrites.push(value)
        }
      }
    }
  })
  assert.equal(ok, true)
  assert.deepEqual(clipboardWrites, ['hello'])

  const body = {
    nodes: [],
    appendChild(node) { this.nodes.push(node) },
    removeChild(node) { this.nodes = this.nodes.filter((n) => n !== node) }
  }
  const fallbackOk = await copyTextToClipboard('fallback', {
    navigatorObj: {},
    documentObj: {
      body,
      createElement() {
        return {
          style: {},
          setAttribute() {},
          select() {},
          value: ''
        }
      },
      execCommand(cmd) {
        return cmd === 'copy'
      }
    }
  })
  assert.equal(fallbackOk, true)
})
