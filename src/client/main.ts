import { createAppState } from './app/state.js'
import { getDomRefs } from './shared/adapters/dom.js'
import type { ConnectionStatus, SignalMessage, TransferMessage } from './shared/domain/types.js'
import { connectWs, wsSend } from './features/connection/application/signaling.js'
import {
  acceptOffer,
  addIceCandidate,
  applyRemoteAnswer,
  sendMeta,
  startPeerConnection,
  switchToRelay,
  type WebRtcPorts
} from './features/connection/application/webrtc.js'
import { bindDropzone, disableDropZone, enableDropZone } from './features/dropzone/ui/dropzone.js'
import {
  cleanupFiles,
  deleteFileItem,
  handleChunk,
  handleMetaMessage
} from './features/transfer/application/transfer.js'
import { renderClients } from './features/peers/ui/peers-panel.js'
import { resetToHome, showRoom } from './features/rooms/application/rooms.js'
import { startQrScanner, stopQrScanner } from './features/qr/application/qr-scanner.js'

const state = createAppState()
const dom = getDomRefs()

const isMobileDevice =
  matchMedia('(pointer: coarse)').matches || /mobile|android|iphone|ipad/i.test(navigator.userAgent)
document.documentElement.classList.toggle('is-mobile', isMobileDevice)
document.documentElement.classList.toggle('is-desktop', !isMobileDevice)

const rtcPorts: WebRtcPorts = {
  setStatus,
  enableDropZone: () => enableDropZone(dom),
  disableDropZone: () => disableDropZone(dom),
  handleMetaMessage: (msg) => handleMetaMessage(state, dom, msg),
  handleChunk: (buffer) => handleChunk(state, buffer)
}

bindDropzone(state, dom, showRoomError)
bindEvents()
autoJoinFromUrl()

// Listen to custom events dispatched by React components and call existing handlers
document.addEventListener('app:create-room', () => createRoom())
document.addEventListener('app:scan-qr', () => dom.btnScanQr.click())
document.addEventListener('app:join-room', (e: Event) => {
  const ce = e as CustomEvent
  const code = ce.detail?.code
  if (code) dom.inputCode.value = String(code)
  joinRoom()
})

async function handleSignal(msg: SignalMessage): Promise<void> {
  switch (msg.type) {
    case 'room-created':
      showRoom(state, dom, msg.code, true)
      setStatus('waiting')
      break
    case 'room-joined':
      showRoom(state, dom, msg.code, false)
      setStatus('waiting')
      break
    case 'peer-joined':
      dom.shareBanner.classList.add('hidden')
      await startPeerConnection(state, rtcPorts, true)
      break
    case 'offer':
      await acceptOffer(state, rtcPorts, msg.sdp)
      break
    case 'answer':
      await applyRemoteAnswer(state, msg.sdp)
      break
    case 'ice-candidate':
      await addIceCandidate(state, msg.candidate)
      break
    case 'client-info':
      state.selfInfo = msg.self
      state.peerInfo = msg.peer
      renderPeerPanel()
      break
    case 'peer-info':
      state.peerInfo = msg.peer
      renderPeerPanel()
      break
    case 'relay-mode':
      switchToRelay(state, rtcPorts)
      break
    case 'peer-disconnected':
      setStatus('waiting')
      state.pc?.close()
      state.pc = null
      state.dc = null
      state.useRelay = false
      state.relayRequested = false
      state.peerInfo = null
      renderPeerPanel()
      disableDropZone(dom)
      break
    case 'kicked':
    case 'banned':
      cleanupFiles(state, dom)
      resetToHome(state, dom, msg.reason ?? 'Has sido desconectado de la sala.')
      break
    case 'error':
      showHomeError(msg.message)
      break
    case 'relay-meta':
      handleMetaMessage(state, dom, msg.payload)
      break
  }
}

function handleRelayMeta(msg: TransferMessage): void {
  handleMetaMessage(state, dom, msg)
}

function renderPeerPanel(): void {
  renderClients(state, dom.clientsList, {
    kickPeer,
    banPeer
  })
}

function createRoom(): void {
  state.isCreator = true
  // visually mark logo as creating
  try {
    dom.brandMark.classList.add('creating')
    dom.brandMark.setAttribute('aria-pressed', 'true')
  } catch (e) {}
  const ws = connectWs(state, {
    onSignal: handleSignal,
    onRelayMeta: handleRelayMeta,
    onBinaryChunk: (buffer) => handleChunk(state, buffer),
    showHomeError
  })
  ws.onopen = () => wsSend(state, { type: 'create-room' })
}

function joinRoom(): void {
  const code = dom.inputCode.value.trim().toUpperCase()
  if (code.length !== 4) {
    showHomeError('El codigo debe tener 4 caracteres')
    return
  }
  state.isCreator = false
  const ws = connectWs(state, {
    onSignal: handleSignal,
    onRelayMeta: handleRelayMeta,
    onBinaryChunk: (buffer) => handleChunk(state, buffer),
    showHomeError
  })
  ws.onopen = () => wsSend(state, { type: 'join-room', code })
}

function kickPeer(): void {
  if (!confirm('Seguro que quieres expulsar al invitado?')) return
  wsSend(state, { type: 'kick-peer' })
  state.peerInfo = null
  renderPeerPanel()
  setStatus('waiting')
  disableDropZone(dom)
}

function banPeer(duration: number | null): void {
  const label = duration ? `${duration} segundos` : 'permanentemente'
  if (!confirm(`Bannear al invitado ${label}?`)) return
  wsSend(state, { type: 'ban-peer', duration })
  state.peerInfo = null
  renderPeerPanel()
  setStatus('waiting')
  disableDropZone(dom)
}

function setStatus(status: ConnectionStatus): void {
  dom.connectionStatus.className = `status status-${status}`
  const labels: Record<ConnectionStatus, string> = {
    waiting: 'Esperando...',
    connected: 'Conectado (P2P)',
    relay: 'Conectado (via servidor)',
    disconnected: 'Desconectado'
  }
  dom.statusText.textContent = labels[status]
}

function showRoomError(message: string): void {
  dom.roomError.textContent = message
  dom.roomError.classList.remove('hidden')
  window.setTimeout(() => dom.roomError.classList.add('hidden'), 4000)
}

function showHomeError(message: string): void {
  dom.homeError.textContent = message
  dom.homeError.classList.remove('hidden')
  // clear creating state if an error occurs
  try {
    dom.brandMark.classList.remove('creating')
    dom.brandMark.setAttribute('aria-pressed', 'false')
  } catch (e) {}
  window.setTimeout(() => dom.homeError.classList.add('hidden'), 3000)
}

function touchAction(fn: () => void) {
  return (e: TouchEvent) => {
    e.preventDefault() // evita el click subsiguiente y el dismiss de teclado en iOS
    fn()
  }
}

function bindEvents(): void {
  dom.btnCreate.addEventListener('click', createRoom)
  dom.btnCreate.addEventListener('touchend', touchAction(createRoom))
  // allow the big logo to act as the primary create button
  dom.brandMark.addEventListener('click', createRoom)
  dom.brandMark.addEventListener('touchend', touchAction(createRoom))
  dom.brandMark.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') createRoom()
  })
  dom.btnJoin.addEventListener('click', joinRoom)
  dom.btnJoin.addEventListener('touchend', touchAction(joinRoom))
  dom.inputCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinRoom()
  })
  dom.inputCode.addEventListener('focus', () => dom.inputCode.select())
  dom.inputCode.addEventListener('click', () => dom.inputCode.select())
  dom.inputCode.addEventListener('input', () => {
    dom.inputCode.value = dom.inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  })
  dom.btnCopyCode.addEventListener('click', () =>
    copyButtonText(dom.btnCopyCode, dom.roomCodeDisplay.textContent ?? '', 'Copiar')
  )
  dom.btnCopyLink.addEventListener('click', () =>
    copyButtonText(dom.btnCopyLink, dom.shareUrl.textContent ?? '', 'Copiar link')
  )
  dom.btnNativeShare.addEventListener('click', nativeShare)
  dom.btnScanQr.addEventListener('click', () => void startQrScanner(dom, showHomeError, joinRoom))
  dom.btnCloseScanner.addEventListener('click', () => stopQrScanner(dom))
  dom.qrScanner.addEventListener('close', () => stopQrScanner(dom))
  dom.fileList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-file]')
    const fileId = button?.dataset.deleteFile
    if (fileId) deleteFileItem(state, dom, fileId, true)
  })
}

async function copyButtonText(
  button: HTMLButtonElement,
  text: string,
  original: string
): Promise<void> {
  if (!text) return
  await navigator.clipboard.writeText(text)
  button.textContent = 'Copiado'
  window.setTimeout(() => {
    button.textContent = original
  }, 1600)
}

async function nativeShare(): Promise<void> {
  const url = dom.shareUrl.textContent ?? ''
  if (!url) return
  if (navigator.share) {
    try {
      await navigator.share({ title: 'fAir Drop', text: 'Entra a mi sala de fAir Drop', url })
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
  }
  await copyButtonText(dom.btnNativeShare, url, 'Compartir')
}

function autoJoinFromUrl(): void {
  const room = new URLSearchParams(location.search).get('room')
  if (room && /^[A-Z0-9]{4}$/i.test(room)) {
    dom.inputCode.value = room.toUpperCase()
    joinRoom()
  }
}

// Keep a tiny imperative port for old inline browser state created by downloaded file links.
Object.assign(window, { sendMeta: (data: TransferMessage) => sendMeta(state, data) })
