export function createPendingRequestBook() {
  const pending = new Map()

  function settle(key, fn) {
    const entry = pending.get(key)
    if (!entry) return false
    pending.delete(key)
    try { clearTimeout(entry.timer) } catch { }
    fn(entry)
    return true
  }

  return {
    create(key, { machineId = null, timeoutMs = 10_000, onTimeout } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key)
          reject(typeof onTimeout === 'function' ? onTimeout() : new Error('pending request timed out'))
        }, timeoutMs)
        pending.set(key, {
          machineId: (typeof machineId === 'string' && machineId.trim()) ? machineId.trim() : null,
          resolve,
          reject,
          timer
        })
      })
    },

    resolve(key, value) {
      return settle(key, (entry) => entry.resolve(value))
    },

    reject(key, error) {
      return settle(key, (entry) => entry.reject(error))
    },

    cancel(key) {
      return settle(key, () => {})
    },

    rejectByMachine(machineId, error) {
      const mid = (typeof machineId === 'string' && machineId.trim()) ? machineId.trim() : null
      if (!mid) return 0
      let count = 0
      for (const [key, entry] of pending.entries()) {
        if (entry?.machineId !== mid) continue
        pending.delete(key)
        try { clearTimeout(entry.timer) } catch { }
        try { entry.reject(error) } catch { }
        count += 1
      }
      return count
    }
  }
}
