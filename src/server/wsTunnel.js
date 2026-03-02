import { WebSocketServer } from 'ws'

export function createTunnelWsServer() {
  // v0: tunneling is not implemented yet; this is just a placeholder surface.
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws) => {
    ws.close()
  })
  return wss
}

