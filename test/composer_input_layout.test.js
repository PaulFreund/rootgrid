import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  DEFAULT_COMPOSER_TEXTAREA_MAX_HEIGHT,
  resolveComposerTextareaMaxHeight
} from '../web/src/lib/composerInputLayout.js'

test('resolveComposerTextareaMaxHeight caps the composer at about one third of the viewport height', () => {
  assert.equal(COMPOSER_TEXTAREA_MIN_HEIGHT, 56)
  assert.equal(resolveComposerTextareaMaxHeight(900), 300)
  assert.equal(resolveComposerTextareaMaxHeight(700), 233)
  assert.equal(resolveComposerTextareaMaxHeight(240), 96)
  assert.equal(resolveComposerTextareaMaxHeight('bad'), DEFAULT_COMPOSER_TEXTAREA_MAX_HEIGHT)
})
