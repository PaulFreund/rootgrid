export async function readJsonBody(req, { limitBytes = 1_000_000 } = {}) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) {
      throw new Error('body too large')
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return null
  return JSON.parse(raw)
}

export function json(res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

