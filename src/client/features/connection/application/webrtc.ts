import type { AppState, ConnectionType } from '@client/app/state'
import type { ConnectionStatus, TransferMessage } from '@shared/domain/types'
import { wsSend } from '@features/connection/application/signaling'

const CONNECT_TIMEOUT_MS = 20000
const DISCONNECT_GRACE_MS = 3500

// Solo STUN — WebRTC negocia P2P directo. TURN se agrega solo si la conexión directa falla.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/**
 * Puertos que el store implementa para comunicarse con la capa WebRTC.
 * Sin referencias al DOM — el store actualiza su estado interno.
 */
export interface WebRtcPorts {
  setStatus(status: ConnectionStatus): void
  setConnectionType(type: ConnectionType): void
  handleMetaMessage(msg: TransferMessage): void
  handleChunk(buffer: ArrayBuffer): void
}

export async function startPeerConnection(
  state: AppState,
  ports: WebRtcPorts,
  asInitiator: boolean,
): Promise<void> {
  clearConnectionTimers(state)
  state.remoteDescSet = false
  state.pendingCandidates = []
  state.relayRequested = false
  state.pc?.close()

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  state.pc = pc
  console.log('[RTC] PeerConnection creado, rol:', asInitiator ? 'creador' : 'invitado')

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) wsSend(state, { type: 'ice-candidate', candidate })
  }

  pc.oniceconnectionstatechange = () => {
    const iceState = pc.iceConnectionState
    console.log('[ICE] estado:', iceState)
    if (iceState === 'failed') switchToRelay(state, ports)
    if (iceState === 'disconnected') {
      state.disconnectTimer = window.setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') switchToRelay(state, ports)
      }, DISCONNECT_GRACE_MS)
    }
    if (iceState === 'connected' || iceState === 'completed') {
      clearTimer(state.disconnectTimer)
      state.disconnectTimer = null
    }
  }

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState
    console.log('[RTC] connectionState:', s)
    if (s === 'connected') {
      clearConnectionTimers(state)
      ports.setStatus('connected')
      // Detectar si es directo o vía TURN
      void detectConnectionType(pc).then((type) => ports.setConnectionType(type))
      return
    }
    if (s === 'failed') switchToRelay(state, ports)
    if (s === 'closed' && !state.useRelay) ports.setStatus('disconnected')
  }

  state.connectTimer = window.setTimeout(() => {
    if (!state.useRelay && state.pc?.connectionState !== 'connected') {
      console.warn('[fAir Drop] P2P tardó demasiado, cambiando a relay')
      switchToRelay(state, ports)
    }
  }, CONNECT_TIMEOUT_MS)

  if (asInitiator) {
    const channel = pc.createDataChannel('fairdrop', { ordered: true })
    setupDataChannel(state, ports, channel)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    wsSend(state, { type: 'offer', sdp: pc.localDescription })
  } else {
    pc.ondatachannel = (event) => setupDataChannel(state, ports, event.channel)
  }
}

export async function applyRemoteAnswer(
  state: AppState,
  sdp: RTCSessionDescriptionInit,
): Promise<void> {
  if (!state.pc) return
  await state.pc.setRemoteDescription(new RTCSessionDescription(sdp))
  state.remoteDescSet = true
  await flushPendingCandidates(state)
}

export async function acceptOffer(
  state: AppState,
  ports: WebRtcPorts,
  sdp: RTCSessionDescriptionInit,
): Promise<void> {
  await startPeerConnection(state, ports, false)
  if (!state.pc) return
  await state.pc.setRemoteDescription(new RTCSessionDescription(sdp))
  state.remoteDescSet = true
  await flushPendingCandidates(state)
  const answer = await state.pc.createAnswer()
  await state.pc.setLocalDescription(answer)
  wsSend(state, { type: 'answer', sdp: state.pc.localDescription })
}

export async function addIceCandidate(
  state: AppState,
  candidate: RTCIceCandidateInit,
): Promise<void> {
  if (state.pc && state.remoteDescSet) {
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (err) {
      console.warn('[ICE] addIceCandidate falló:', err)
    }
  } else {
    state.pendingCandidates.push(candidate)
  }
}

export function switchToRelay(state: AppState, ports: WebRtcPorts): void {
  if (state.useRelay || state.relayRequested) return
  state.useRelay = true
  state.relayRequested = true
  clearConnectionTimers(state)
  state.pc?.close()
  state.pc = null
  state.dc = null
  state.connectionType = 'unknown'
  wsSend(state, { type: 'relay-mode' })
  ports.setStatus('relay')
}

export function relaySend(state: AppState, data: TransferMessage | ArrayBuffer): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
  if (data instanceof ArrayBuffer) {
    state.ws.send(data)
  } else {
    state.ws.send(JSON.stringify({ type: 'relay-meta', payload: data }))
  }
}

export function sendMeta(state: AppState, data: TransferMessage): void {
  if (state.useRelay) {
    relaySend(state, data)
  } else if (state.dc?.readyState === 'open') {
    state.dc.send(JSON.stringify(data))
  }
}

// ── Internos ─────────────────────────────────────────────────────────────────

/**
 * Detecta si la conexión P2P es directa o pasa por un servidor TURN.
 * Revisa el candidato ICE seleccionado: si es de tipo 'relay', usa TURN.
 */
async function detectConnectionType(pc: RTCPeerConnection): Promise<ConnectionType> {
  try {
    const stats = await pc.getStats()
    let selectedPairId: string | undefined
    // Primera pasada: encontrar el transport con selectedCandidatePairId
    for (const [, report] of stats) {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPairId = report.selectedCandidatePairId
        break
      }
    }
    if (!selectedPairId) return 'unknown'
    // Segunda pasada: encontrar el candidate pair y el remote candidate
    const pair = stats.get(selectedPairId)
    if (pair?.type === 'candidate-pair' && pair.remoteCandidateId) {
      const remoteCandidate = stats.get(pair.remoteCandidateId)
      if (remoteCandidate?.candidateType === 'relay') {
        console.log('[ICE] Conexión vía TURN (relay)')
        return 'turn'
      }
      console.log('[ICE] Conexión directa (P2P)')
      return 'direct'
    }
  } catch (err) {
    console.warn('[ICE] No se pudo detectar tipo de conexión:', err)
  }
  return 'unknown'
}

function setupDataChannel(state: AppState, ports: WebRtcPorts, channel: RTCDataChannel): void {
  state.dc = channel
  channel.binaryType = 'arraybuffer'
  channel.onopen = () => {
    clearConnectionTimers(state)
    ports.setStatus('connected')
  }
  channel.onclose = () => {
    if (!state.useRelay) {
      state.connectionType = 'unknown'
      ports.setStatus('disconnected')
    }
  }
  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      ports.handleMetaMessage(JSON.parse(event.data))
    } else {
      ports.handleChunk(event.data)
    }
  }
}

async function flushPendingCandidates(state: AppState): Promise<void> {
  if (!state.pc) return
  const pending = [...state.pendingCandidates]
  state.pendingCandidates = []
  for (const candidate of pending) {
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (err) {
      console.warn('[ICE] flush falló:', err)
    }
  }
}

function clearConnectionTimers(state: AppState): void {
  clearTimer(state.connectTimer)
  clearTimer(state.disconnectTimer)
  state.connectTimer = null
  state.disconnectTimer = null
}

function clearTimer(timer: number | null): void {
  if (timer) window.clearTimeout(timer)
}
