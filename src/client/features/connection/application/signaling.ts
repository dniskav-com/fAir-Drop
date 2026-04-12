import type { AppPorts, AppState } from '@client/app/state'

export function connectWs(state: AppState, ports: AppPorts): WebSocket {
  state.ws?.close()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)
  state.ws = ws
  ws.binaryType = 'arraybuffer'

  ws.onmessage = (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      ports.onBinaryChunk(event.data)
      return
    }
    const msg = JSON.parse(String(event.data))
    if (msg.type === 'relay-meta') {
      ports.onRelayMeta(msg.payload)
      return
    }
    void ports.onSignal(msg)
  }

  ws.onerror = () => ports.showHomeError('Error de conexion con el servidor')
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null
  }

  return ws
}

export function wsSend(state: AppState, msg: unknown): void {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg))
  }
}
