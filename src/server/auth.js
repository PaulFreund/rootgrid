import crypto from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64url')
}

function base64UrlDecode(str) {
  return Buffer.from(String(str), 'base64url')
}

function loadOrCreateSecretKey(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { chmodSync(dirname(path), 0o700) } catch { }

  if (existsSync(path)) {
    return readFileSync(path)
  }

  const key = crypto.randomBytes(32)
  writeFileSync(path, key, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { }
  return key
}

function sign(secretKey, data) {
  return crypto.createHmac('sha256', secretKey).update(data).digest('base64url')
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export class AuthService {
  /**
   * @param {{ clientToken: string, secretKeyPath: string, trustProxy?: boolean, ttlMs?: number }} opts
   */
  constructor({ clientToken, secretKeyPath, trustProxy = false, ttlMs = 30 * 24 * 60 * 60 * 1000 }) {
    this.clientToken = clientToken
    this.trustProxy = trustProxy
    this.ttlMs = ttlMs
    this.secretKey = loadOrCreateSecretKey(secretKeyPath)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   */
  getSessionIdFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie)
    return cookies.rootgrid_session ?? null
  }

  isSecureRequest(req) {
    // Direct HTTPS
    if (req.socket?.encrypted) return true

    // Behind a reverse proxy
    if (this.trustProxy) {
      const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
      if (proto === 'https') return true
    }

    return false
  }

  requireAuth(req, res) {
    if (!this.checkAuth(req)) return this.#unauthorized(res)
    return true
  }

  /**
   * Check auth without writing a response (useful for WS upgrades).
   * @param {import('node:http').IncomingMessage} req
   */
  checkAuth(req) {
    const sid = this.getSessionIdFromRequest(req)
    if (!sid) return false
    const [data, sig] = String(sid).split('.')
    if (!data || !sig) return false

    const expected = sign(this.secretKey, data)
    if (!safeEqual(sig, expected)) return false

    let payload
    try {
      payload = JSON.parse(base64UrlDecode(data).toString('utf-8'))
    } catch {
      return false
    }

    if (payload?.exp && Date.now() > payload.exp) return false
    return true
  }

  handleAuth(req, res, body) {
    if (!body || typeof body !== 'object') return this.#badRequest(res, 'invalid json')
    if (!safeEqual(body.token, this.clientToken)) return this.#unauthorized(res)

    const now = Date.now()
    const data = base64UrlEncode(JSON.stringify({
      v: 1,
      iat: now,
      exp: now + this.ttlMs
    }))
    const sid = `${data}.${sign(this.secretKey, data)}`

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    const secure = this.isSecureRequest(req)
    res.setHeader('Set-Cookie', [
      `rootgrid_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.ttlMs / 1000)}${secure ? '; Secure' : ''}`
    ])
    res.end(JSON.stringify({ ok: true }))
  }

  handleLogout(req, res) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    const secure = this.isSecureRequest(req)
    res.setHeader('Set-Cookie', [
      `rootgrid_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`
    ])
    res.end(JSON.stringify({ ok: true }))
  }

  #unauthorized(res) {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return false
  }

  #badRequest(res, msg) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify({ error: msg }))
    return false
  }
}
