export class SSEManager {
  #timer

  constructor({ heartbeatMs = 30_000 } = {}) {
    this.heartbeatMs = heartbeatMs
    this.clients = new Set()
    this.#timer = setInterval(() => this.#heartbeat(), heartbeatMs).unref?.()
  }

  addClient(res) {
    this.clients.add(res)
    res.on('close', () => {
      this.clients.delete(res)
    })
  }

  send(envelope) {
    const data = `data: ${JSON.stringify(envelope)}\n\n`
    for (const res of this.clients) {
      try {
        res.write(data)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  #heartbeat() {
    for (const res of this.clients) {
      try {
        res.write(`: heartbeat\n\n`)
      } catch {
        this.clients.delete(res)
      }
    }
  }
}
