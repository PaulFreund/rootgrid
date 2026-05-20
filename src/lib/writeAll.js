/**
 * Write the full buffer to a FileHandle, retrying short writes until complete.
 *
 * @param {import('node:fs/promises').FileHandle} file
 * @param {Buffer} buffer
 * @param {number | null} position
 */
export async function writeAll(file, buffer, position = null) {
  let offset = 0
  while (offset < buffer.length) {
    const targetPos = position === null ? null : (position + offset)
    const out = await file.write(buffer, offset, buffer.length - offset, targetPos)
    const bytesWritten = Number(out?.bytesWritten ?? 0)
    if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
      throw new Error('short write')
    }
    offset += bytesWritten
  }
  return offset
}
