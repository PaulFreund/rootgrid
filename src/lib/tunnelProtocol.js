export const TUNNEL_FRAME = {
  OPEN: 0,
  DATA: 1,
  END: 2,
  ERROR: 3,
  HEADERS: 4
}

/**
 * Frame format:
 * - u8 type
 * - u32be streamId
 * - payload (bytes)
 *
 * @param {number} type
 * @param {number} streamId
 * @param {Buffer} [payload]
 */
export function encodeTunnelFrame(type, streamId, payload = Buffer.alloc(0)) {
  const p = payload ?? Buffer.alloc(0)
  const buf = Buffer.allocUnsafe(5 + p.length)
  buf.writeUInt8(type & 0xff, 0)
  buf.writeUInt32BE(streamId >>> 0, 1)
  if (p.length) p.copy(buf, 5)
  return buf
}

/**
 * @param {Buffer} buf
 */
export function decodeTunnelFrame(buf) {
  const b = Buffer.from(buf)
  if (b.length < 5) return null
  const type = b.readUInt8(0)
  const streamId = b.readUInt32BE(1)
  const payload = b.subarray(5)
  return { type, streamId, payload }
}

export function encodeTunnelJsonFrame(type, streamId, obj) {
  const payload = Buffer.from(JSON.stringify(obj ?? null), 'utf8')
  return encodeTunnelFrame(type, streamId, payload)
}

export function decodeTunnelJsonPayload(payload) {
  try {
    return JSON.parse(Buffer.from(payload).toString('utf8'))
  } catch {
    return null
  }
}

