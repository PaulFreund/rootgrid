import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWorkspaceGitSections } from '../web/src/lib/workspaceGit.js'

test('buildWorkspaceGitSections attaches staged and unstaged per-file diffs', () => {
  const sections = buildWorkspaceGitSections({
    entries: [
      { path: 'src/staged.js', x: 'M', y: ' ', label: 'M' },
      { path: 'src/unstaged.js', x: ' ', y: 'M', label: 'M' },
      { path: 'new.txt', x: '?', y: '?', label: '??' }
    ],
    stagedDiff: [
      'diff --git a/src/staged.js b/src/staged.js',
      '--- a/src/staged.js',
      '+++ b/src/staged.js',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n'),
    unstagedDiff: [
      'diff --git a/src/unstaged.js b/src/unstaged.js',
      '--- a/src/unstaged.js',
      '+++ b/src/unstaged.js',
      '@@ -2 +2 @@',
      '-before',
      '+after'
    ].join('\n')
  })

  const staged = sections.find((section) => section.key === 'staged')?.cards ?? []
  const unstaged = sections.find((section) => section.key === 'changes')?.cards ?? []
  const untracked = sections.find((section) => section.key === 'untracked')?.cards ?? []

  assert.equal(staged[0]?.path, 'src/staged.js')
  assert.equal(staged[0]?.hasDiff, true)
  assert.deepEqual(staged[0]?.diffSummary, { added: 1, removed: 1, hunks: 1 })
  assert.equal(staged[0]?.diffFile?.lines?.[4]?.oldLine, 1)
  assert.equal(staged[0]?.diffFile?.lines?.[5]?.newLine, 1)

  assert.equal(unstaged[0]?.path, 'src/unstaged.js')
  assert.equal(unstaged[0]?.hasDiff, true)
  assert.deepEqual(unstaged[0]?.diffSummary, { added: 1, removed: 1, hunks: 1 })

  assert.equal(untracked[0]?.path, 'new.txt')
  assert.equal(untracked[0]?.hasDiff, false)
})

test('buildWorkspaceGitSections preserves whitespace-only diff classification for git cards', () => {
  const sections = buildWorkspaceGitSections({
    entries: [
      { path: 'src/format.js', x: ' ', y: 'M', label: 'M' }
    ],
    unstagedDiff: [
      'diff --git a/src/format.js b/src/format.js',
      '--- a/src/format.js',
      '+++ b/src/format.js',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const  value = 1;'
    ].join('\n')
  })

  const card = sections.find((section) => section.key === 'changes')?.cards?.[0] ?? null
  assert.equal(card?.diffFile?.lines?.[4]?.changeKind, 'whitespace')
  assert.equal(card?.diffFile?.lines?.[5]?.changeKind, 'whitespace')
})

test('buildWorkspaceGitSections keeps card ids stable when a file moves between unstaged and staged', () => {
  const unstagedSections = buildWorkspaceGitSections({
    entries: [
      { path: 'src/demo.js', x: ' ', y: 'M', label: 'M' }
    ]
  })
  const stagedSections = buildWorkspaceGitSections({
    entries: [
      { path: 'src/demo.js', x: 'M', y: ' ', label: 'M' }
    ]
  })

  const unstagedCard = unstagedSections.find((section) => section.key === 'changes')?.cards?.[0] ?? null
  const stagedCard = stagedSections.find((section) => section.key === 'staged')?.cards?.[0] ?? null

  assert.equal(unstagedCard?.id, 'src/demo.js')
  assert.equal(stagedCard?.id, 'src/demo.js')
})
