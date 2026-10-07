/**
 * FairDropStore — núcleo reactivo de la aplicación.
 *
 * TypeScript puro, sin DOM, sin React ni ningún otro framework.
 * Cualquier UI (React, Vue, Svelte, vanilla DOM, etc.) puede consumirlo:
 *
 *   const store = new FairDropStore()
 *   const unsub = store.subscribe(() => render(store.getState()))
 *   store.createRoom()
 */

import { createAppState } from '../client/app/state.js'
import type { AppPorts, AppState } from '../client/app/state.js'
import type {
  ConnectionStatus,
  ExpiryConfig,
  SignalMessage,
  TextDeletedMessage,
  TextMessage,
  TransferMessage,
} from '../client/shared/domain/types.js'
import { connectWs, wsSend } from '../client/features/connection/application/signaling.js'
import {
  acceptOffer,
  addIceCandidate,
  applyRemoteAnswer,
  sendMeta,
  startPeerConnection,
  switchToRelay,
  type WebRtcPorts,
} from '../client/features/connection/application/webrtc.js'
import {
  cleanupFiles,
  deleteFile,
  handleChunk,
  handleMetaMessage,
  recordDownload,
  sendFiles,
} from '../client/features/transfer/application/transfer.js'
import {
  sendText as sendTextFeature,
  handleTextMessage,
  deleteText as deleteTextFeature,
  recordCopy as recordCopyFeature,
} from '../client/features/text/application/text.js'
import { showRoom, resetToHome } from '../client/features/rooms/application/rooms.js'

export type { AppState }
export type { ExpiryConfig }

// ── Sesión de sala persistente (reconexión entre recargas) ───────────────────
// sessionStorage: sobrevive a recargas de la pestaña, muere al cerrarla.
export interface SavedSession {
  code: string
  role: 'creator' | 'joiner'
}

const SESSION_KEY = 'fairdrop-session'

function saveSession(session: SavedSession): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* almacenamiento no disponible */
  }
}

export function getSavedSession(): SavedSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedSession
    if (typeof parsed?.code === 'string' && /^[A-Z0-9]{4}$/.test(parsed.code)) {
      return { code: parsed.code.toUpperCase(), role: parsed.role === 'creator' ? 'creator' : 'joiner' }
    }
    return null
  } catch {
    return null
  }
}

function clearSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
}

export class FairDropStore {
  // _state es SIEMPRE la misma referencia. Los callbacks WebRTC asíncronos
  // (ondatachannel, onopen…) capturan esta referencia y pueden mutarla
  // en cualquier momento sin perder sincronía.
  private _state: AppState = createAppState()

  // _snap es el snapshot que React lee. Se reemplaza en cada notify() para
  // que useSyncExternalStore detecte el cambio por igualdad de referencia.
  // Así _state nunca se reemplaza y los closures siempre apuntan al objeto correcto.
  private _snap: Readonly<AppState> = this._state

  private _listeners = new Set<() => void>()

  // Reconexión automática de sala
  private _reconnectTimer: number | null = null
  private _reconnectAttempts = 0

  // ── Lectura de estado ───────────────────────────────────────────────────────

  getState = (): Readonly<AppState> => {
    return this._snap
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  // ── Mutación interna ────────────────────────────────────────────────────────

  // Crea un nuevo snapshot (nueva referencia para React) sin tocar _state.
  // Esto preserva las referencias capturadas por los callbacks WebRTC.
  private notify = (): void => {
    this._snap = { ...this._state }
    this._listeners.forEach((fn) => fn())
  }

  // Cierra el WebSocket limpiamente. Llamar en beforeunload para que el
  // servidor elimine la sala antes de que iOS/Android mantengan el socket vivo.
  disconnect(): void {
    this.clearReconnectTimer()
    this._state.ws?.close()
    this._state.ws = null
  }

  // ── Reconexión automática de sala ───────────────────────────────────────────

  private clearReconnectTimer(): void {
    if (this._reconnectTimer !== null) {
      window.clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  private maxReconnectAttempts(): number {
    // Debe caber dentro del periodo de gracia del servidor (~3 min)
    return 12
  }

  // Llamado por ports.onClose: la conexión se cayó mientras estábamos en sala
  private handleSocketDrop(): void {
    const state = this._state
    if (!state.roomCode) return // no estábamos en sala (home/leave)
    if (this._reconnectTimer !== null) return // ya hay reintento en curso
    this.scheduleReconnect(this.reconnectDelay())
  }

  private scheduleReconnect(delayMs: number): void {
    const state = this._state
    if (!state.roomCode) return
    state.connectionStatus = 'disconnected'
    state.pc?.close()
    state.pc = null
    state.dc = null
    state.useRelay = false
    state.relayRequested = false
    this.notify()
    this._reconnectTimer = window.setTimeout(() => {
      this._reconnectTimer = null
      if (!state.roomCode) return
      this.attemptReconnect()
    }, delayMs)
  }

  /**
   * Reconectar con la misma sala: el creador envía "reclaim-room" y el
   * invitado "join-room". Si la sala ya expiró, el servidor responde
   * con error y el cliente vuelve al home (via handleSignal 'error').
   */
  private attemptReconnect(): void {
    const state = this._state
    const code = state.roomCode
    if (!code || state.ws) return
    this._reconnectAttempts++
    if (this._reconnectAttempts > this.maxReconnectAttempts()) {
      this.cleanup()
      resetToHome(state, 'Se perdió la conexión con la sala y no se pudo reconectar.', this.notify)
      return
    }
    const isCreator = state.isCreator
    const ws = connectWs(state, this.makePorts())
    ws.onopen = () => {
      wsSend(
        state,
        isCreator ? { type: 'reclaim-room', code } : { type: 'join-room', code },
      )
    }
  }

  // Espaciado de reintentos: 1s, 2s, 3s ... máx 8s
  private reconnectDelay(): number {
    return Math.min(1000 * (this._reconnectAttempts + 1), 8000)
  }

  private setStatus(status: ConnectionStatus): void {
    this._state.connectionStatus = status
    this.notify()
  }

  private setConnectionType(type: import('../client/app/state').ConnectionType): void {
    this._state.connectionType = type
    this.notify()
  }

  private showHomeError(message: string): void {
    this._state.homeError = message
    this.notify()
    window.setTimeout(() => {
      this._state.homeError = null
      this.notify()
    }, 3500)
  }

  private showRoomError(message: string): void {
    this._state.roomError = message
    this.notify()
    window.setTimeout(() => {
      this._state.roomError = null
      this.notify()
    }, 4000)
  }

  // ── Sala ────────────────────────────────────────────────────────────────────

  private makePorts(): AppPorts {
    return {
      onSignal: (msg) => this.handleSignal(msg),
      onRelayMeta: (msg) => {
        if (msg.type === 'text-inline') {
          handleTextMessage(this._state, msg as TextMessage, this.notify)
        } else if (msg.type === 'text-deleted') {
          deleteTextFeature(this._state, (msg as TextDeletedMessage).id, this.notify)
        } else {
          handleMetaMessage(this._state, msg, this.notify)
        }
      },
      onBinaryChunk: (buf) => handleChunk(this._state, buf, this.notify),
      showHomeError: (msg) => this.showHomeError(msg),
      onClose: () => this.handleSocketDrop(),
    }
  }

  createRoom(): void {
    this._reconnectAttempts = 0
    this._state.isCreator = true
    const ws = connectWs(this._state, this.makePorts())
    ws.onopen = () => wsSend(this._state, { type: 'create-room' })
  }

  joinRoom(code: string): void {
    if (code.length !== 4) {
      this.showHomeError('El código debe tener 4 caracteres.')
      return
    }
    this._reconnectAttempts = 0
    this._state.isCreator = false
    const ws = connectWs(this._state, this.makePorts())
    ws.onopen = () => wsSend(this._state, { type: 'join-room', code })
  }

  /**
   * Re-entrar a una sala guardada (sesión previa o URL con ?room=).
   * El creador usa reclaim-room; el invitado join-room. Si la sala ya
   * no existe, el servidor responde con error y se vuelve al home.
   */
  rejoinSaved(saved: SavedSession): void {
    this._reconnectAttempts = 0
    this._state.isCreator = saved.role === 'creator'
    const ws = connectWs(this._state, this.makePorts())
    ws.onopen = () => {
      wsSend(
        this._state,
        saved.role === 'creator'
          ? { type: 'reclaim-room', code: saved.code }
          : { type: 'join-room', code: saved.code },
      )
    }
  }

  leaveRoom(reason?: string): void {
    // Salida intencionada: avisar al servidor ANTES de cerrar para que
    // borre la sala al instante (sin esperar el periodo de gracia).
    if (this._state.isCreator) {
      wsSend(this._state, { type: 'close-room' })
    }
    this.disconnect()
    this.cleanup()
    resetToHome(this._state, reason, this.notify)
  }

  private cleanup(): void {
    clearSession()
    this.clearReconnectTimer()
    this._reconnectAttempts = 0
    cleanupFiles(this._state, this.notify)
    this._state.textMessages.clear()
    this._state.textExpiry.forEach((t) => {
      if (t.timer) window.clearTimeout(t.timer)
    })
    this._state.textExpiry.clear()
    this._state.pendingText = null
  }

  // ── Peers ───────────────────────────────────────────────────────────────────

  kickPeer(): void {
    wsSend(this._state, { type: 'kick-peer' })
    this._state.peerInfo = null
    this._state.connectionStatus = 'waiting'
    this.notify()
  }

  banPeer(duration: number | null): void {
    wsSend(this._state, { type: 'ban-peer', duration })
    this._state.peerInfo = null
    this._state.connectionStatus = 'waiting'
    this.notify()
  }

  // ── Transferencia ───────────────────────────────────────────────────────────

  sendFiles(files: File[], expiry: ExpiryConfig | null = null): Promise<void> {
    return sendFiles(this._state, files, expiry, this.notify, (msg) => this.showRoomError(msg))
  }

  deleteFile(fileId: string): void {
    deleteFile(this._state, fileId, true, this.notify)
  }

  recordDownload(fileId: string): void {
    recordDownload(this._state, fileId, this.notify)
  }

  // ── Texto inline ───────────────────────────────────────────────────────────

  setPendingText(text: string | null): void {
    this._state.pendingText = text
    this.notify()
  }

  sendText(content: string, format: string, expiry: ExpiryConfig | null = null): void {
    sendTextFeature(this._state, content, format, expiry, this.notify)
  }

  deleteText(id: string): void {
    deleteTextFeature(this._state, id, this.notify)
  }

  recordTextCopy(id: string): void {
    recordCopyFeature(this._state, id, this.notify)
  }

  /**
   * Reintentar conexión P2P desde modo relay.
   * Cierra la conexión actual y solicita una nueva negociación WebRTC.
   */
  retryP2P(): void {
    const state = this._state
    // Resetear estado de relay para forzar nuevo intento P2P
    state.useRelay = false
    state.relayRequested = false
    state.connectionType = 'unknown'
    state.pc?.close()
    state.pc = null
    state.dc = null
    this.setStatus('waiting')
    // Notificar al peer que también reintente
    wsSend(state, { type: 'retry-p2p' })
    // Iniciar nueva conexión peer
    startPeerConnection(state, this.rtcPorts, state.isCreator)
  }

  // ── Señalización interna ────────────────────────────────────────────────────

  private get rtcPorts(): WebRtcPorts {
    return {
      setStatus: (s) => this.setStatus(s),
      setConnectionType: (t) => this.setConnectionType(t),
      handleMetaMessage: (msg) => {
        if (msg.type === 'text-inline') {
          handleTextMessage(this._state, msg as TextMessage, this.notify)
        } else if (msg.type === 'text-deleted') {
          deleteTextFeature(this._state, (msg as TextDeletedMessage).id, this.notify)
        } else {
          handleMetaMessage(this._state, msg, this.notify)
        }
      },
      handleChunk: (buf) => handleChunk(this._state, buf, this.notify),
    }
  }

  private async handleSignal(msg: SignalMessage): Promise<void> {
    const state = this._state
    switch (msg.type) {
      case 'room-created':
        showRoom(state, msg.code, true, this.notify)
        this._reconnectAttempts = 0
        saveSession({ code: msg.code, role: 'creator' })
        this.setStatus('waiting')
        break

      case 'room-joined':
        showRoom(state, msg.code, false, this.notify)
        this._reconnectAttempts = 0
        saveSession({ code: msg.code, role: 'joiner' })
        this.setStatus('waiting')
        break

      case 'room-reclaimed':
        showRoom(state, msg.code, true, this.notify)
        this._reconnectAttempts = 0
        saveSession({ code: msg.code, role: 'creator' })
        this.setStatus('waiting')
        break

      case 'peer-joined':
        await startPeerConnection(state, this.rtcPorts, true)
        break

      case 'offer':
        await acceptOffer(state, this.rtcPorts, msg.sdp)
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
        this.notify()
        break

      case 'peer-info':
        state.peerInfo = msg.peer
        this.notify()
        break

      case 'relay-mode':
        switchToRelay(state, this.rtcPorts)
        break

      case 'retry-p2p':
        // El otro peer quiere reintentar P2P, resetear y esperar la oferta
        state.useRelay = false
        state.relayRequested = false
        state.connectionType = 'unknown'
        state.pc?.close()
        state.pc = null
        state.dc = null
        this.setStatus('waiting')
        // El creator iniciará la nueva oferta
        if (state.isCreator) {
          startPeerConnection(state, this.rtcPorts, true)
        }
        break

      case 'peer-disconnected':
        state.pc?.close()
        state.pc = null
        state.dc = null
        state.useRelay = false
        state.relayRequested = false
        state.peerInfo = null
        this.setStatus('waiting')
        break

      case 'kicked':
      case 'banned':
        this.cleanup()
        resetToHome(state, msg.reason ?? 'Has sido desconectado de la sala.', this.notify)
        break

      case 'room-closed':
        this.cleanup()
        resetToHome(state, msg.reason ?? 'La sala se cerró.', this.notify)
        break

      case 'error':
        // Un error landing mientras estamos dentro de la sala (ej: la sala
        // ya expiró al reconectar) debe devolvernos al home con el motivo.
        if (state.screen === 'room') {
          this.cleanup()
          resetToHome(state, msg.message, this.notify)
        } else {
          this.showHomeError(msg.message)
        }
        break

      case 'relay-meta':
        if (msg.payload.type === 'text-inline') {
          handleTextMessage(state, msg.payload as TextMessage, this.notify)
        } else if (msg.payload.type === 'text-deleted') {
          deleteTextFeature(state, (msg.payload as TextDeletedMessage).id, this.notify)
        } else {
          handleMetaMessage(state, msg.payload, this.notify)
        }
        break
    }
  }
}
