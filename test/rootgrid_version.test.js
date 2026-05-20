import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveRootgridVersion,
  readGitCommitSuffix,
  readManagedReleaseVersion,
  readPackageVersion
} from '../src/lib/rootgridVersion.js'

test('rootgrid version helpers prefer release manifest, then package version, then git suffix', () => {
  const files = new Map([
    ['/tmp/rootgrid/package.json', JSON.stringify({ version: '0.0.0' })],
    ['/tmp/rootgrid/release.json', JSON.stringify({ version: '0.0.0+gmanifest123456' })]
  ])
  const readFile = (path) => {
    if (!files.has(path)) throw new Error('missing')
    return files.get(path)
  }
  const spawn = () => ({ status: 0, stdout: 'abcdef123456\n' })

  assert.equal(readPackageVersion({ packageRoot: '/tmp/rootgrid', readFile }), '0.0.0')
  assert.equal(readManagedReleaseVersion({ packageRoot: '/tmp/rootgrid', readFile }), '0.0.0+gmanifest123456')
  assert.equal(deriveRootgridVersion({ packageRoot: '/tmp/rootgrid', readFile, spawn }), '0.0.0+gmanifest123456')
})

test('rootgrid version helpers append the git commit when no managed release manifest exists', () => {
  const files = new Map([
    ['/tmp/rootgrid/package.json', JSON.stringify({ version: '0.0.0' })]
  ])
  const readFile = (path) => {
    if (!files.has(path)) throw new Error('missing')
    return files.get(path)
  }
  const spawn = () => ({ status: 0, stdout: 'abcdef123456\n' })

  assert.equal(readGitCommitSuffix({ packageRoot: '/tmp/rootgrid', spawn }), 'gabcdef123456')
  assert.equal(deriveRootgridVersion({ packageRoot: '/tmp/rootgrid', readFile, spawn }), '0.0.0+gabcdef123456')
})

test('rootgrid version helpers fall back to package version when git is unavailable', () => {
  const files = new Map([
    ['/tmp/rootgrid/package.json', JSON.stringify({ version: '1.2.3' })]
  ])
  const readFile = (path) => {
    if (!files.has(path)) throw new Error('missing')
    return files.get(path)
  }
  const spawn = () => ({ status: 1, stdout: '' })

  assert.equal(deriveRootgridVersion({ packageRoot: '/tmp/rootgrid', readFile, spawn }), '1.2.3')
})
