export function modelCatalogCacheKey({ machineId, cwd = '', limit = 200, includeHidden = false } = {}) {
  return [
    String(machineId ?? '').trim(),
    String(cwd ?? ''),
    String(Number(limit) || 200),
    includeHidden ? '1' : '0'
  ].join('\n')
}

export function createModelCatalogCache({
  load,
  ttlMs = 30_000,
  maxEntries = 32,
  now = () => Date.now()
}) {
  const entries = new Map()

  function touch(key, entry) {
    if (entries.has(key)) entries.delete(key)
    entries.set(key, entry)
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) break
      entries.delete(oldestKey)
    }
    return entry
  }

  async function list(params) {
    const key = modelCatalogCacheKey(params)
    const current = now()
    const cached = entries.get(key)
    if (cached?.value && cached.expiresAt > current) {
      touch(key, cached)
      return cached.value
    }
    if (cached?.promise) return cached.promise

    const promise = Promise.resolve()
      .then(() => load(params))
      .then((value) => {
        touch(key, {
          machineId: String(params?.machineId ?? '').trim(),
          value,
          expiresAt: now() + ttlMs
        })
        return value
      })
      .catch((err) => {
        const pending = entries.get(key)
        if (pending?.promise === promise) entries.delete(key)
        throw err
      })

    touch(key, {
      machineId: String(params?.machineId ?? '').trim(),
      promise,
      expiresAt: 0
    })

    return promise
  }

  function clearMachine(machineId) {
    const target = String(machineId ?? '').trim()
    if (!target) return
    for (const [key, entry] of entries.entries()) {
      if (entry?.machineId === target) entries.delete(key)
    }
  }

  function clear() {
    entries.clear()
  }

  return {
    list,
    clear,
    clearMachine
  }
}
