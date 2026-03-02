import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

import { CREATE_SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'

export class Store {
  /**
   * @param {{ dbPath: string }} opts
   */
  constructor({ dbPath }) {
    this.dbPath = dbPath

    if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
      const dir = dirname(dbPath)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { }

      if (!existsSync(dbPath)) {
        try {
          const fd = openSync(dbPath, 'a', 0o600)
          closeSync(fd)
        } catch {
        }
      }
    }

    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')

    this.#initSchema()

    if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try { chmodSync(path, 0o600) } catch { }
      }
    }
  }

  #initSchema() {
    const current = this.db.prepare('PRAGMA user_version').get()['user_version']
    if (current === 0) {
      this.db.exec(CREATE_SCHEMA_SQL)
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return
    }
    if (current !== SCHEMA_VERSION) {
      throw new Error(`DB schema mismatch: have ${current}, expected ${SCHEMA_VERSION}`)
    }
  }

  upsertMachine({ machineId, machineName, platform, capabilities }) {
    const now = Date.now()
    const capabilitiesJson = capabilities ? JSON.stringify(capabilities) : null
    this.db.prepare(`
      INSERT INTO machines(machine_id, machine_name, platform, last_seen_ms, capabilities_json)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET
        machine_name=excluded.machine_name,
        platform=excluded.platform,
        last_seen_ms=excluded.last_seen_ms,
        capabilities_json=excluded.capabilities_json
    `).run(machineId, machineName, platform, now, capabilitiesJson)
  }

  updateMachineLastSeen(machineId) {
    const now = Date.now()
    this.db.prepare(`UPDATE machines SET last_seen_ms=? WHERE machine_id=?`).run(now, machineId)
  }

  listMachines() {
    const rows = this.db.prepare(`
      SELECT machine_id, machine_name, platform, last_seen_ms, capabilities_json
      FROM machines
      ORDER BY machine_name ASC
    `).all()
    return rows.map((r) => ({
      machineId: r.machine_id,
      machineName: r.machine_name,
      platform: r.platform,
      lastSeenMs: r.last_seen_ms,
      capabilities: r.capabilities_json ? JSON.parse(r.capabilities_json) : null
    }))
  }
}

