export function createHoverCloseController({
  delayMs = 120,
  setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimer = (...args) => globalThis.clearTimeout(...args)
} = {}) {
  let timer = null

  function cancel() {
    if (!timer) return
    try { clearTimer(timer) } catch {
    }
    timer = null
  }

  function schedule(onClose) {
    cancel()
    timer = setTimer(() => {
      timer = null
      onClose()
    }, delayMs)
    return timer
  }

  function dispose() {
    cancel()
  }

  return {
    schedule,
    cancel,
    dispose
  }
}
