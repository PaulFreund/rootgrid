import test from 'node:test'
import assert from 'node:assert/strict'

import {
  approvalPolicyCandidates,
  buildResumeThreadAttempts,
  buildStartTurnAttempts,
  minimizeFileChanges,
  normalizeAgentMessagePhase,
  sandboxPolicyCandidates,
  tryExtractAgentMessageText,
  tryExtractDeltaText,
  tryExtractReasoningText
} from '../src/runner/sessions/codexSessionProtocol.js'

test('approval and sandbox compatibility helpers prefer current variants before legacy fallbacks', () => {
  assert.deepEqual(approvalPolicyCandidates('untrusted'), ['untrusted', 'unlessTrusted'])
  assert.deepEqual(approvalPolicyCandidates('on-failure'), ['on-failure', 'onFailure'])
  assert.deepEqual(approvalPolicyCandidates('onRequest'), ['on-request', 'onRequest'])
  assert.deepEqual(approvalPolicyCandidates('reject'), ['reject'])
  assert.deepEqual(sandboxPolicyCandidates('workspace-write', '/repo'), [
    { type: 'workspaceWrite', writableRoots: ['/repo'] },
    { type: 'workspaceWrite' },
    'workspaceWrite',
    'workspace-write'
  ])
})

test('buildResumeThreadAttempts includes threadId/id fallbacks plus reasoning variants', () => {
  const attempts = buildResumeThreadAttempts({
    threadId: 'thread-1',
    cwd: '/repo',
    model: 'gpt-5',
    approvalPolicies: ['onRequest'],
    sandboxes: ['workspaceWrite'],
    reasoningEfforts: ['medium']
  })

  assert.ok(attempts.some((params) => {
    return params.threadId === 'thread-1' && params.approvalPolicy === 'onRequest' && params.sandbox === 'workspaceWrite'
  }))
  assert.ok(attempts.some((params) => {
    return params.id === 'thread-1' && params.reasoningEffort === 'medium'
  }))
  assert.ok(attempts.some((params) => {
    return params.threadId === 'thread-1' && params.reasoning?.effort === 'medium'
  }))
})

test('buildStartTurnAttempts prefers sandboxPolicy variants before sandbox fallback and base fallback', () => {
  const attempts = buildStartTurnAttempts({
    threadId: 'thread-1',
    cwd: '/repo',
    input: [{ type: 'text', text: 'hello' }],
    model: 'gpt-5',
    approvalPolicies: ['onRequest'],
    sandboxes: ['workspaceWrite'],
    sandboxPolicies: ['workspaceWrite', { type: 'workspaceWrite', writableRoots: ['/repo'] }]
  })

  assert.deepEqual(attempts[0]?.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['/repo'] })
  assert.equal('sandbox' in attempts[0], false)
  assert.ok(attempts.some((params) => params.sandbox === 'workspaceWrite'))
  assert.deepEqual(attempts.at(-1), {
    threadId: 'thread-1',
    cwd: '/repo',
    input: [{ type: 'text', text: 'hello' }],
    model: 'gpt-5'
  })
})

test('Codex item extraction helpers normalize mixed content shapes', () => {
  assert.equal(tryExtractDeltaText({ chunk: { value: 'delta text' } }), 'delta text')
  assert.equal(tryExtractAgentMessageText({
    content: ['hello ', { text: 'world' }, { value: '!' }]
  }), 'hello world!')
  assert.equal(tryExtractReasoningText({
    summary: ['first', 'second'],
    content: ['ignored']
  }), 'first\nsecond')
})

test('normalizeAgentMessagePhase keeps commentary/final_answer distinctions', () => {
  assert.equal(normalizeAgentMessagePhase('commentary'), 'commentary')
  assert.equal(normalizeAgentMessagePhase('final_answer'), 'final_answer')
  assert.equal(normalizeAgentMessagePhase('final-answer'), 'final_answer')
  assert.equal(normalizeAgentMessagePhase(' Final Answer '), 'final_answer')
  assert.equal(normalizeAgentMessagePhase(null), null)
})

test('minimizeFileChanges keeps only small path/kind records', () => {
  assert.deepEqual(minimizeFileChanges([
    null,
    { path: ' src/a.js ', kind: ' edit ' },
    { path: '', kind: 'edit' },
    { path: 'src/b.js' }
  ]), [
    { path: ' src/a.js ', kind: ' edit ' },
    { path: 'src/b.js' }
  ])
})
