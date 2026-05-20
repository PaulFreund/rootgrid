import test from 'node:test'
import assert from 'node:assert/strict'

import { buildIdeBasePath, buildIdeUrlPath, stripIdeBasePath } from '../src/lib/idePaths.js'

test('buildIdeBasePath scopes IDE routes under /vscode/<id>', () => {
  assert.equal(buildIdeBasePath('ide-1'), '/vscode/ide-1')
  assert.equal(buildIdeBasePath(''), '/vscode')
})

test('buildIdeUrlPath includes the target folder query when provided', () => {
  assert.equal(buildIdeUrlPath('ide-1'), '/vscode/ide-1/')
  assert.equal(buildIdeUrlPath('ide-1', '/tmp/workspace'), '/vscode/ide-1/?folder=%2Ftmp%2Fworkspace')
})

test('stripIdeBasePath removes the IDE prefix and preserves inner paths', () => {
  assert.equal(stripIdeBasePath('/vscode/ide-1', 'ide-1'), '/')
  assert.equal(stripIdeBasePath('/vscode/ide-1/', 'ide-1'), '/')
  assert.equal(stripIdeBasePath('/vscode/ide-1/?folder=/tmp', 'ide-1'), '/?folder=/tmp')
  assert.equal(stripIdeBasePath('/vscode/ide-1/static/out.js', 'ide-1'), '/static/out.js')
  assert.equal(stripIdeBasePath('/other/path', 'ide-1'), '/other/path')
})
