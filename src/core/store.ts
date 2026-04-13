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
import type { AppState } from '../client/app/state.js'
import type {
  ConnectionStatus,
  ExpiryConfig,
  SignalMessage,
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
import { showRoom, resetToHome } from '../client/features/rooms/application/rooms.js'

export type { AppState }
export type { ExpiryConfig }

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
    this._state.ws?.close()
    this._state.ws = null
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

  createRoom(): void {
    this._state.isCreator = true
    const ws = connectWs(this._state, {
      onSignal: (msg) => this.handleSignal(msg),
      onRelayMeta: (msg) => handleMetaMessage(this._state, msg, this.notify),
      onBinaryChunk: (buf) => handleChunk(this._state, buf, this.notify),
      showHomeError: (msg) => this.showHomeError(msg),
    })
    ws.onopen = () => wsSend(this._state, { type: 'create-room' })
  }

  joinRoom(code: string): void {
    if (code.length !== 4) {
      this.showHomeError('El código debe tener 4 caracteres.')
      return
    }
    this._state.isCreator = false
    const ws = connectWs(this._state, {
      onSignal: (msg) => this.handleSignal(msg),
      onRelayMeta: (msg) => handleMetaMessage(this._state, msg, this.notify),
      onBinaryChunk: (buf) => handleChunk(this._state, buf, this.notify),
      showHomeError: (msg) => this.showHomeError(msg),
    })
    ws.onopen = () => wsSend(this._state, { type: 'join-room', code })
  }

  leaveRoom(reason?: string): void {
    // Close the WebSocket to notify the server and ensure the room is
    // removed immediately (avoids zombie rooms on mobile reloads).
    this.disconnect()
    cleanupFiles(this._state, this.notify)
    resetToHome(this._state, reason, this.notify)
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

  // ── Señalización interna ────────────────────────────────────────────────────

  private get rtcPorts(): WebRtcPorts {
    return {
      setStatus: (s) => this.setStatus(s),
      setConnectionType: (t) => this.setConnectionType(t),
      handleMetaMessage: (msg) => handleMetaMessage(this._state, msg, this.notify),
      handleChunk: (buf) => handleChunk(this._state, buf, this.notify),
    }
  }

  private async handleSignal(msg: SignalMessage): Promise<void> {
    const state = this._state
    switch (msg.type) {
      case 'room-created':
        showRoom(state, msg.code, true, this.notify)
        this.setStatus('waiting')
        break

      case 'room-joined':
        showRoom(state, msg.code, false, this.notify)
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
        cleanupFiles(state, this.notify)
        resetToHome(state, msg.reason ?? 'Has sido desconectado de la sala.', this.notify)
        break

      case 'error':
        this.showHomeError(msg.message)
        break

      case 'relay-meta':
        handleMetaMessage(state, msg.payload, this.notify)
        break
    }
  }
}
