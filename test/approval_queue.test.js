import test from 'node:test'
import assert from 'node:assert/strict'

import {
  enqueueApproval,
  removeApproval,
  replaceApprovalQueue
} from '../web/src/lib/approvalQueue.js'

test('approval queue helpers replace, dedupe, and remove approvals while syncing ids', () => {
  const queue = []
  const approvalIds = new Set()

  replaceApprovalQueue(queue, [
    { approvalId: 'a-1' },
    { approvalId: 'a-1' },
    { approvalId: 'a-2' }
  ], approvalIds)
  assert.deepEqual(queue.map((approval) => approval.approvalId), ['a-1', 'a-2'])
  assert.equal(approvalIds.has('a-1'), true)
  assert.equal(approvalIds.has('a-2'), true)

  assert.equal(enqueueApproval(queue, { approvalId: 'a-2' }, approvalIds), false)
  assert.equal(enqueueApproval(queue, { approvalId: 'a-3' }, approvalIds), true)
  assert.deepEqual(queue.map((approval) => approval.approvalId), ['a-1', 'a-2', 'a-3'])

  assert.equal(removeApproval(queue, 'a-2', approvalIds), true)
  assert.deepEqual(queue.map((approval) => approval.approvalId), ['a-1', 'a-3'])
  assert.equal(approvalIds.has('a-2'), false)
})

