import crypto from 'node:crypto'

function parseCookies(headerValue) {
  const header = headerValue ?? ''
  const out = Object.create(null)
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export class AuthService {
  /**
   * @param {{ clientToken: string }} opts
   */
  constructor({ clientToken }) {
    this.clientToken = clientToken
    this.sessions = new Map()
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   */
  getSessionIdFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie)
    return cookies.rootgrid_session ?? null
  }

  requireAuth(req, res) {
    const sid = this.getSessionIdFromRequest(req)
    if (!sid) return this.#unauthorized(res)
    if (!this.sessions.has(sid)) return this.#unauthorized(res)
    return true
  }

  handleAuth(req, res, body) {
    if (!body || typeof body !== 'object') return this.#badRequest(res, 'invalid json')
    if (body.token !== this.clientToken) return this.#unauthorized(res)

    const sid = crypto.randomUUID()
    this.sessions.set(sid, { createdMs: Date.now() })

    // v0: in-memory sessions only.
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Set-Cookie', [
      `rootgrid_session=${sid}; Path=/; HttpOnly; SameSite=Lax`
    ])
    res.end(JSON.stringify({ ok: true }))
  }

  #unauthorized(res) {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return false
  }

  #badRequest(res, msg) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: msg }))
    return false
  }
}
