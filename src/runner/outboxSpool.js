import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmodSync } from 'node:fs'
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { getRootgridDir } from '../lib/paths.js'
import { readJsonFile, writeJsonFile } from '../lib/jsonFile.js'

function safeParseJson(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export class OutboxSpool {
  /**
   * Append-only JSONL outbox spool so runner events survive brief host disconnects
   * and runner restarts. This implements at-least-once delivery when combined
   * with host ACKs and idempotent eventIds.
   *
   * v0 implementation:
   * - outbox log is JSONL of the *envelope* (must include `seq`)
   * - state file stores `{ lastAckSeq }`
   * - compaction drops lines with `seq <= lastAckSeq` when the file grows
   *
   * @param {{
   *   machineId: string,
   *   dir?: string,
   *   maxBytes?: number,
   * }} opts
   */
  constructor({ machineId, dir = join(getRootgridDir(), 'outbox'), maxBytes = 64 * 1024 * 1024 }) {
    this.machineId = machineId
    this.dir = dir
    this.maxBytes = maxBytes

    this.logPath = join(this.dir, `runner-${machineId}.jsonl`)
    this.statePath = join(this.dir, `runner-${machineId}.state.json`)

    this.disabled = false
    this.lastAckSeq = 0
    this.lastCompactedAckSeq = 0

    /** @type {Promise<void>} */
    this.queue = Promise.resolve()
    this.#statThrottleUntil = 0
  }

  #statThrottleUntil

  async #ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try { chmodSync(this.dir, 0o700) } catch { }
  }

  async load() {
    await this.#ensureDir()

    // Load ACK cursor.
    let lastAckSeq = 0
    if (await fileExists(this.statePath)) {
      try {
        const state = await readJsonFile(this.statePath)
        lastAckSeq = Number(state?.lastAckSeq ?? 0) || 0
      } catch {
        lastAckSeq = 0
      }
    }

    this.lastAckSeq = lastAckSeq
    this.lastCompactedAckSeq = lastAckSeq

    /** @type {Map<number, any>} */
    const pending = new Map()
    let maxSeq = lastAckSeq

    if (existsSync(this.logPath)) {
      const rl = createInterface({
        input: createReadStream(this.logPath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      })
      for await (const line of rl) {
        const env = safeParseJson(String(line ?? '').trim())
        if (!env || typeof env !== 'object') continue
        const seq = Number(env.seq)
        if (!Number.isFinite(seq)) continue
        if (seq <= lastAckSeq) continue
        pending.set(seq, env)
        if (seq > maxSeq) maxSeq = seq
      }
    }

    return { lastAckSeq, pending, maxSeq }
  }

  /**
   * @param {any} envelope
   */
  append(envelope) {
    if (this.disabled) return
    const seq = Number(envelope?.seq)
    if (!Number.isFinite(seq)) return

    const line = `${JSON.stringify(envelope)}\n`
    this.queue = this.queue
      .then(async () => {
        await this.#ensureDir()
        await appendFile(this.logPath, line, { encoding: 'utf8', mode: 0o600 })
        try { chmodSync(this.logPath, 0o600) } catch { }
      })
      .then(() => this.#maybeCompact())
      .catch(() => { /* best-effort */ })
  }

  /**
   * Persist ACK cursor.
   * @param {number} lastAckSeq
   */
  ack(lastAckSeq) {
    if (this.disabled) return
    const n = Number(lastAckSeq)
    if (!Number.isFinite(n)) return
    if (n <= this.lastAckSeq) return
    this.lastAckSeq = n

    this.queue = this.queue
      .then(async () => {
        await this.#ensureDir()
        await writeJsonFile(this.statePath, { v: 1, machineId: this.machineId, lastAckSeq: this.lastAckSeq }, { mode: 0o600 })
        try { chmodSync(this.statePath, 0o600) } catch { }
      })
      .then(() => this.#maybeCompact())
      .catch(() => { /* best-effort */ })
  }

  async #maybeCompact() {
    if (this.disabled) return

    const now = Date.now()
    if (now < this.#statThrottleUntil) return
    this.#statThrottleUntil = now + 5_000

    let st
    try {
      st = await stat(this.logPath)
    } catch {
      return
    }

    if (st.size > this.maxBytes) {
      await this.#compact()
      let st2
      try { st2 = await stat(this.logPath) } catch { st2 = null }
      if (st2 && st2.size > this.maxBytes) {
        // Pending data itself is too large; stop writing new data to disk to
        // avoid unbounded growth. We still keep the in-memory queue.
        this.disabled = true
        console.warn(`[rootgrid] outbox spool disabled (too large): ${this.logPath}`)
      }
      return
    }

    // If we haven't compacted since ACKs advanced, occasionally shrink the log.
    if (st.size > 8 * 1024 * 1024 && this.lastAckSeq > this.lastCompactedAckSeq) {
      await this.#compact()
    }
  }

  async #compact() {
    if (this.disabled) return
    if (!existsSync(this.logPath)) return

    const ack = this.lastAckSeq
    const tmpPath = `${this.logPath}.tmp`

    // Best-effort: replace log with only unacked envelopes.
    const input = createReadStream(this.logPath, { encoding: 'utf8' })
    const rl = createInterface({ input, crlfDelay: Infinity })
    const out = createWriteStream(tmpPath, { encoding: 'utf8', flags: 'w', mode: 0o600 })

    try {
      for await (const line of rl) {
        const raw = String(line ?? '').trim()
        if (!raw) continue
        const env = safeParseJson(raw)
        const seq = Number(env?.seq)
        if (!Number.isFinite(seq)) continue
        if (seq <= ack) continue
        out.write(`${raw}\n`)
      }
    } catch {
      try { out.end() } catch { }
      try { input.destroy() } catch { }
      try { await unlink(tmpPath) } catch { }
      return
    }

    await new Promise((resolve) => out.end(resolve))
    try { await rename(tmpPath, this.logPath) } catch { }
    try { chmodSync(this.logPath, 0o600) } catch { }

    this.lastCompactedAckSeq = ack
  }
}
