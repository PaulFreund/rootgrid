export function replaceApprovalQueue(queue, approvals, approvalIds = null) {
  const list = Array.isArray(queue) ? queue : []
  const next = Array.isArray(approvals) ? approvals : []
  list.splice(0, list.length)
  approvalIds?.clear?.()
  for (const approval of next) {
    const approvalId = String(approval?.approvalId ?? '').trim()
    if (!approvalId) continue
    if (approvalIds?.has?.(approvalId)) continue
    list.push(approval)
    approvalIds?.add?.(approvalId)
  }
  return list.length
}

export function enqueueApproval(queue, approval, approvalIds = null) {
  const list = Array.isArray(queue) ? queue : []
  const approvalId = String(approval?.approvalId ?? '').trim()
  if (!approvalId) {
    list.push(approval)
    return true
  }
  if (approvalIds?.has?.(approvalId)) return false
  list.push(approval)
  approvalIds?.add?.(approvalId)
  return true
}

export function removeApproval(queue, approvalId, approvalIds = null) {
  const list = Array.isArray(queue) ? queue : []
  const id = String(approvalId ?? '').trim()
  if (!id) return false
  approvalIds?.delete?.(id)
  const idx = list.findIndex((entry) => String(entry?.approvalId ?? '') === id)
  if (idx < 0) return false
  list.splice(idx, 1)
  return true
}

