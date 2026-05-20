function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

export function stripAnsiText(value) {
  return String(value ?? '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function normalizeText(value) {
  return stripAnsiText(value)
    .replace(/\r\n/g, '\n')
    .trim()
}

function firstNonEmptyLine(value) {
  const lines = normalizeText(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[0] ?? null
}

function stripTrailingPunctuation(value) {
  return String(value ?? '').replace(/[),.;:]+$/g, '')
}

function findDeviceCodeCandidate(value) {
  const text = trimText(value)
  if (!text) return null
  const matches = text.match(/[A-Z0-9]+(?:-[A-Z0-9]+)+/gi) ?? []
  for (const match of matches) {
    const candidate = String(match ?? '').toUpperCase()
    if (candidate.length < 6) continue
    if (!/[A-Z]/.test(candidate) || !/\d/.test(candidate)) continue
    if (/(?:AUTHORIZATION|VERIFICATION|DEVICE|USER|ENTER|CODE|BROWSER|OPEN)/i.test(candidate)) continue
    return candidate
  }
  return null
}

export function codexDeviceAuthSucceeded(value) {
  const text = normalizeText(value)
  if (!text) return false
  const lower = text.toLowerCase()
  return (
    lower.includes('successfully logged in')
    || lower.includes('logged in using chatgpt')
    || lower.includes('signed in using chatgpt')
  )
}

export function detectCodexAuthIssue(value) {
  const text = normalizeText(value)
  if (!text) return null
  const lower = text.toLowerCase()

  if (
    lower.includes('refresh_token_reused') ||
    lower.includes('refresh token has already been used to generate a new access token') ||
    (lower.includes('failed to refresh token') && lower.includes('sign in again'))
  ) {
    return {
      status: 'reauth-required',
      code: 'refresh_token_reused',
      message: 'Codex refresh token was already used. Log out and sign in again on this runner.',
      needsReauth: true,
      details: text
    }
  }

  if (
    lower.includes('not logged in') ||
    lower.includes('please run codex login')
  ) {
    return {
      status: 'not-authenticated',
      code: 'not_logged_in',
      message: 'Codex is not signed in on this runner.',
      needsReauth: false,
      details: text
    }
  }

  if (
    lower.includes('401 unauthorized') ||
    (lower.includes('unauthorized') && lower.includes('sign in again'))
  ) {
    return {
      status: 'reauth-required',
      code: 'unauthorized',
      message: 'Codex authentication failed on this runner. Log out and sign in again.',
      needsReauth: true,
      details: text
    }
  }

  return null
}

export function parseCodexLoginStatus(value, {
  exitCode = null
} = {}) {
  const text = normalizeText(value)
  const issue = detectCodexAuthIssue(text)
  if (issue) {
    return {
      status: issue.status,
      code: issue.code,
      provider: null,
      message: issue.message,
      needsReauth: issue.needsReauth
    }
  }

  const line = firstNonEmptyLine(text)
  const loggedInMatch = line?.match(/^logged in(?: using (.+))?$/i)
  if (loggedInMatch) {
    const provider = trimText(loggedInMatch[1])
    return {
      status: 'authenticated',
      code: null,
      provider,
      message: provider ? `Signed in using ${provider}.` : 'Codex is signed in.',
      needsReauth: false
    }
  }

  if (line && /not logged in/i.test(line)) {
    return {
      status: 'not-authenticated',
      code: 'not_logged_in',
      provider: null,
      message: 'Codex is not signed in on this runner.',
      needsReauth: false
    }
  }

  if (Number(exitCode) === 1 && !text) {
    return {
      status: 'not-authenticated',
      code: 'not_logged_in',
      provider: null,
      message: 'Codex is not signed in on this runner.',
      needsReauth: false
    }
  }

  return {
    status: 'unknown',
    code: null,
    provider: null,
    message: line ?? 'Unable to determine Codex sign-in state.',
    needsReauth: false
  }
}

export function parseCodexDeviceAuthOutput(value) {
  const text = normalizeText(value)
  if (!text) {
    return {
      verificationUrl: null,
      userCode: null
    }
  }

  let verificationUrl = null
  const explicitUrlMatch = text.match(/(?:visit|open|go to|browser)\D+(https?:\/\/\S+)/i)
  const fallbackUrlMatch = text.match(/https?:\/\/\S+/i)
  verificationUrl = stripTrailingPunctuation(explicitUrlMatch?.[1] ?? fallbackUrlMatch?.[0] ?? '')
  if (!verificationUrl) verificationUrl = null

  let userCode = null
  const lines = text
    .split('\n')
    .map((line) => String(line ?? '').trim())
    .filter(Boolean)

  const labelPattern = /\b(?:authorization|user|verification|device)\s+code\b/i
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]
    if (!labelPattern.test(line)) continue

    const inlineCode = findDeviceCodeCandidate(line)
    if (inlineCode) {
      userCode = inlineCode
      break
    }

    const nextLineCode = findDeviceCodeCandidate(lines[idx + 1] ?? '')
    if (nextLineCode) {
      userCode = nextLineCode
      break
    }
  }

  if (!userCode) {
    for (const line of lines) {
      const nextCode = findDeviceCodeCandidate(line)
      if (!nextCode) continue
      userCode = nextCode
      break
    }
  }

  return {
    verificationUrl,
    userCode
  }
}
