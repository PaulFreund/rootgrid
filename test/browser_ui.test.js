import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createNotificationSoundPlayer,
  copyTextToClipboard,
  dismissToastById,
  parseWorkspaceFileLinkHref,
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

test('createNotificationSoundPlayer reuses the audio element and resets playback', () => {
  const created = []
  class FakeAudio {
    constructor(url) {
      this.url = url
      this.currentTime = 4
      created.push(this)
    }

    load() {
      this.loaded = true
    }

    pause() {
      this.paused = true
    }

    play() {
      this.played = true
      return Promise.resolve()
    }
  }

  const player = createNotificationSoundPlayer({
    isEnabled: () => true,
    AudioCtor: FakeAudio,
    audioUrl: '/notification.mp3'
  })

  assert.equal(player.preload(), true)
  assert.equal(player.play(), true)
  assert.equal(player.play(), true)
  assert.equal(created.length, 1)
  assert.equal(created[0].url, '/notification.mp3')
  assert.equal(created[0].loaded, true)
  assert.equal(created[0].paused, true)
  assert.equal(created[0].currentTime, 0)
  assert.equal(created[0].played, true)
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

test('parseWorkspaceFileLinkHref recognizes filesystem links and ignores web links', () => {
  assert.deepEqual(
    parseWorkspaceFileLinkHref('/mnt/d/prj/rootgrid/web/src/App.vue#L560'),
    { path: '/mnt/d/prj/rootgrid/web/src/App.vue', line: 560 }
  )

  assert.deepEqual(
    parseWorkspaceFileLinkHref('file:///home/wook/project/README.md#L12'),
    { path: '/home/wook/project/README.md', line: 12 }
  )

  assert.equal(parseWorkspaceFileLinkHref('https://example.com/docs'), null)
  assert.equal(parseWorkspaceFileLinkHref('/settings'), null)
})
