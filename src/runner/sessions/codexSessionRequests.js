export function isApprovalRequestMethod(method) {
  return method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
}

export function isUserInputRequestMethod(method) {
  return method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput'
}

export function buildApprovalRequestEvent({ approvalId, sessionId, cwd, method, params }) {
  if (!isApprovalRequestMethod(method)) return null

  const kind = method.includes('commandExecution') ? 'command' : 'fileChange'
  const itemId = params?.itemId ?? params?.item?.id ?? null
  const threadId = params?.threadId ?? null
  const turnId = params?.turnId ?? null
  const approvalCallbackId = params?.approvalId ?? null
  const reason = params?.reason ?? params?.prompt ?? null
  const command = params?.command ?? params?.item?.command ?? null
  const safeCwd = params?.cwd ?? cwd ?? null

  return {
    approvalId,
    sessionId,
    kind,
    ...(itemId ? { itemId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(approvalCallbackId ? { approvalCallbackId } : {}),
    ...(reason ? { reason } : {}),
    ...(command ? { command } : {}),
    ...(safeCwd ? { cwd: safeCwd } : {}),
    ...(params?.grantRoot ? { grantRoot: params.grantRoot } : {}),
    ...(params?.availableDecisions ? { availableDecisions: params.availableDecisions } : {}),
    ...(params?.additionalPermissions ? { additionalPermissions: params.additionalPermissions } : {}),
    ...(params?.commandActions ? { commandActions: params.commandActions } : {}),
    ...(params?.proposedExecpolicyAmendment ? { proposedExecpolicyAmendment: params.proposedExecpolicyAmendment } : {}),
    ...(params?.proposedNetworkPolicyAmendments ? { proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments } : {}),
    ...(params?.networkApprovalContext ? { networkApprovalContext: params.networkApprovalContext } : {})
  }
}

export function buildUserInputRequestEvent({ approvalId, sessionId, cwd, params }) {
  return {
    approvalId,
    sessionId,
    kind: 'userInput',
    ...(params?.itemId ? { itemId: params.itemId } : {}),
    ...(params?.threadId ? { threadId: params.threadId } : {}),
    ...(params?.turnId ? { turnId: params.turnId } : {}),
    questions: Array.isArray(params?.questions) ? params.questions : [],
    ...(cwd ? { cwd } : {})
  }
}
