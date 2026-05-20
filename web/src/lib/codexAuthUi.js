function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function buildIssueFromCode(code) {
  const safeCode = trimText(code)
  if (safeCode === 'refresh_token_reused') {
    return {
      code: 'refresh_token_reused',
      message: 'Codex needs ChatGPT sign-in again on this runner.'
    }
  }
  if (safeCode === 'unauthorized') {
    return {
      code: 'unauthorized',
      message: 'Codex authentication failed on this runner.'
    }
  }
  if (safeCode === 'not_logged_in') {
    return {
      code: 'not_logged_in',
      message: 'Codex is not signed in on this runner.'
    }
  }
  return null
}

export function detectCodexMissingIssueText(value) {
  const text = normalizeText(value)
  if (!text) return null
  const lower = text.toLowerCase()

  if (
    lower.includes('codex is not installed on this runner') ||
    lower.includes('install managed codex') ||
    (lower.includes('spawn') && lower.includes('codex') && lower.includes('enoent')) ||
    lower.includes('configured codex binary is missing')
  ) {
    return {
      code: 'codex_missing',
      message: 'Managed Codex is missing on this runner. Install it to use chat sessions and model listing.'
    }
  }

  return null
}

export function detectCodexAuthIssueText(value) {
  const text = normalizeText(value)
  if (!text) return null
  const lower = text.toLowerCase()

  if (
    lower.includes('refresh_token_reused') ||
    lower.includes('refresh token has already been used to generate a new access token') ||
    (lower.includes('failed to refresh token') && lower.includes('sign in again'))
  ) {
    return {
      code: 'refresh_token_reused',
      message: 'Codex needs ChatGPT sign-in again on this runner.'
    }
  }

  if (
    lower.includes('401 unauthorized') ||
    (lower.includes('unauthorized') && lower.includes('sign in again'))
  ) {
    return {
      code: 'unauthorized',
      message: 'Codex authentication failed on this runner.'
    }
  }

  if (
    lower.includes('not logged in') ||
    lower.includes('please run codex login')
  ) {
    return {
      code: 'not_logged_in',
      message: 'Codex is not signed in on this runner.'
    }
  }

  return null
}

export function detectCodexAuthIssueFromSessionError(payload) {
  if (!payload || typeof payload !== 'object') return null
  const fromCode = buildIssueFromCode(payload?.code)
  if (fromCode) return fromCode
  const message = trimText(payload?.message)
  const details = trimText(payload?.details)
  return detectCodexAuthIssueText([message, details].filter(Boolean).join('\n'))
}

export function buildLegacyCodexAuthTool(issue) {
  if (!issue || typeof issue !== 'object') return null
  const code = trimText(issue.code)
  const message = trimText(issue.message) ?? 'Codex needs sign-in on this runner.'
  return {
    id: 'codex',
    label: 'Codex',
    installed: true,
    auth: {
      status: code === 'not_logged_in' ? 'not-authenticated' : 'reauth-required',
      code,
      message,
      flow: null
    }
  }
}
