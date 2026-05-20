import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

function resolveMimeType(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export function getWebDistDir() {
  return fileURLToPath(new URL('../../web/dist/', import.meta.url))
}

export function serveWeb(req, res) {
  const distDir = getWebDistDir()
  if (!existsSync(distDir)) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end([
      '<!doctype html>',
      '<meta charset="utf-8">',
      '<title>Rootgrid</title>',
      '<h1>Rootgrid</h1>',
      '<p>Web UI is not built yet. (Missing <code>web/dist</code>)</p>'
    ].join('\n'))
    return true
  }

  const url = new URL(req.url ?? '/', 'http://local')
  const rawPath = url.pathname
  const safePath = normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '')
  const candidate = join(distDir, safePath)

  // If path is a file, serve it. Otherwise, fall back to index.html (SPA).
  if (existsSync(candidate)) {
    const st = statSync(candidate)
    if (st.isFile()) {
      res.statusCode = 200
      res.setHeader('Content-Type', resolveMimeType(candidate))
      createReadStream(candidate).pipe(res)
      return true
    }
  }

  const indexHtml = join(distDir, 'index.html')
  if (!existsSync(indexHtml)) return false
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  createReadStream(indexHtml).pipe(res)
  return true
}
