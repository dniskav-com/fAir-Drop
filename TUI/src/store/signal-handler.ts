import type { AppState, SignalMsg, PeerInfo, LogEntry } from '../types'

export interface SignalDeps {
  addLog(msg: string, type?: LogEntry['type']): void
  emit(): void
  send(msg: unknown): void
  resetToHome(): void
  clearPendingReceive(): void
}

export function handleSignal(state: AppState, msg: SignalMsg, deps: SignalDeps): void {
  const { addLog, emit, send, resetToHome } = deps

  switch (msg.type) {
    case 'room-created':
      state.screen = 'room'
      state.roomCode = msg.code
      state.connectionStatus = 'waiting'
      addLog(`Sala creada: ${msg.code}`, 'success')
      break

    case 'room-joined':
      state.screen = 'room'
      state.roomCode = msg.code
      state.connectionStatus = 'waiting'
      addLog(`Unido a sala: ${msg.code}`, 'success')
      break

    case 'peer-joined':
      state.peerInfo = { ip: '…', browser: 'Conectando', mobile: false, connectedAt: null }
      send({ type: 'relay-mode' })
      state.connectionStatus = 'relay'
      state.connectionType = 'relay'
      addLog('Peer conectado — modo relay activado', 'success')
      break

    case 'offer':
      send({ type: 'relay-mode' })
      state.connectionStatus = 'relay'
      state.connectionType = 'relay'
      addLog('Peer conectado (relay)', 'success')
      break

    case 'client-info': {
      const ci = msg as { type: 'client-info'; self: PeerInfo; peer: PeerInfo | null }
      state.selfInfo = ci.self
      if (ci.peer) state.peerInfo = ci.peer
      break
    }

    case 'peer-info':
      state.peerInfo = (msg as { type: 'peer-info'; peer: PeerInfo }).peer
      break

    case 'relay-mode':
      if (state.connectionStatus !== 'relay') {
        state.connectionStatus = 'relay'
        state.connectionType = 'relay'
        addLog('Modo relay confirmado', 'info')
      }
      break

    case 'peer-disconnected':
      state.peerInfo = null
      state.connectionStatus = 'waiting'
      state.connectionType = 'unknown'
      state.transfers.clear()
      deps.clearPendingReceive()
      addLog('Peer desconectado', 'warning')
      break

    case 'kicked':
    case 'banned':
      addLog(msg.reason ?? 'Desconectado de la sala', 'error')
      resetToHome()
      break

    case 'error':
      addLog(msg.message, 'error')
      state.homeError = msg.message
      setTimeout(() => { state.homeError = null; emit() }, 3500)
      break

    case 'ice-candidate':
    case 'answer':
      break
  }

  emit()
}
