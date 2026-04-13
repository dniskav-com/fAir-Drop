import { createAppState } from '../app/state.js'
import type { AppPorts, AppState, ExpiryRuntime } from '../app/state.js'
import type {
  ConnectionStatus,
  ExpiryConfig,
  SignalMessage,
  TransferMessage,
} from '../shared/domain/types.js'
import { connectWs, wsSend } from '../features/connection/application/signaling.js'
import {
  startPeerConnection,
  applyRemoteAnswer,
  acceptOffer,
  addIceCandidate,
  switchToRelay,
} from '../features/connection/application/webrtc.js'
import type { WebRtcPorts } from '../features/connection/application/webrtc.js'
import {
  sendFiles as sendFilesImpl,
  handleMetaMessage,
  handleChunk,
  deleteFile as deleteFileImpl,
  cleanupFiles,
  recordDownload as recordDownloadImpl,
} from '../features/transfer/application/transfer.js'
import { showRoom, resetToHome } from '../features/rooms/application/rooms.js'

export type { AppState, ExpiryRuntime } from '../app/state.js'
export type { ExpiryConfig } from '../shared/domain/types.js'

export class FairDropStore {
  private _state: AppState = createAppState()
  private _listeners = new Set<() => void>()

  // ── useSyncExternalStore interface ──────────────────────────────────────────
  // Arrow functions so they keep `this` when passed as bare references
  subscribe = (callback: () => void): (() => void) => {
    this._listeners.add(callback)
    return () => this._listeners.delete(callback)
  }

  getState = (): Readonly<AppState> => {
    return this._state
  }

  private notify = (): void => {
    // Shallow-clone to give React a new reference and trigger re-render
    this._state = { ...this._state }
    this._listeners.forEach((fn) => fn())
  }

  // ── Internal ports ──────────────────────────────────────────────────────────
  private get rtcPorts(): WebRtcPorts {
    return {
      setStatus: (status: ConnectionStatus) => {
        this._state.connectionStatus = status
        if (status === 'disconnected') {
          resetToHome(this._state, 'La conexión se perdió.', this.notify)
        } else {
          this.notify()
        }
      },
      setConnectionType: (type: import('../app/state').ConnectionType) => {
        this._state.connectionType = type
        this.notify()
      },
      handleMetaMessage: (msg: TransferMessage) => {
        handleMetaMessage(this._state, msg, this.notify)
      },
      handleChunk: (buffer: ArrayBuffer) => {
        handleChunk(this._state, buffer, this.notify)
      },
    }
  }

  private get appPorts(): AppPorts {
    return {
      onSignal: (msg: SignalMessage) => this._handleSignal(msg),
      onRelayMeta: (msg: TransferMessage) => {
        handleMetaMessage(this._state, msg, this.notify)
      },
      onBinaryChunk: (buffer: ArrayBuffer) => {
        handleChunk(this._state, buffer, this.notify)
      },
      showHomeError: (message: string) => {
        this._state.homeError = message
        this.notify()
        window.setTimeout(() => {
          this._state.homeError = null
          this.notify()
        }, 5000)
      },
    }
  }

  // ── Public actions ──────────────────────────────────────────────────────────
  createRoom(): void {
    const ws = connectWs(this._state, this.appPorts)
    ws.onopen = () => wsSend(this._state, { type: 'create-room' })
  }

  joinRoom(code: string): void {
    const ws = connectWs(this._state, this.appPorts)
    ws.onopen = () => wsSend(this._state, { type: 'join-room', code })
  }

  async sendFiles(files: File[], expiry: ExpiryConfig | null): Promise<void> {
    await sendFilesImpl(this._state, files, expiry, this.notify, (msg) => {
      this._state.roomError = msg
      this.notify()
    })
  }

  deleteFile(fileId: string): void {
    deleteFileImpl(this._state, fileId, true, this.notify)
  }

  recordDownload(fileId: string): void {
    recordDownloadImpl(this._state, fileId, this.notify)
  }

  kickPeer(): void {
    wsSend(this._state, { type: 'kick-peer' })
  }

  banPeer(duration: number | null): void {
    wsSend(this._state, { type: 'ban-peer', duration })
  }

  // ── Signal handling ─────────────────────────────────────────────────────────
  private async _handleSignal(msg: SignalMessage): Promise<void> {
    switch (msg.type) {
      case 'room-created':
        showRoom(this._state, msg.code, true, this.notify)
        break

      case 'room-joined':
        showRoom(this._state, msg.code, false, this.notify)
        break

      case 'peer-joined':
        await startPeerConnection(this._state, this.rtcPorts, true)
        break

      case 'offer':
        await acceptOffer(this._state, this.rtcPorts, msg.sdp)
        break

      case 'answer':
        await applyRemoteAnswer(this._state, msg.sdp)
        break

      case 'ice-candidate':
        await addIceCandidate(this._state, msg.candidate)
        break

      case 'client-info':
        this._state.selfInfo = msg.self
        this._state.peerInfo = msg.peer
        this.notify()
        break

      case 'peer-info':
        this._state.peerInfo = msg.peer
        this.notify()
        break

      case 'relay-mode':
        this._state.useRelay = true
        this._state.connectionStatus = 'relay'
        this.notify()
        break

      case 'peer-disconnected':
        cleanupFiles(this._state, this.notify)
        this._state.peerInfo = null
        this._state.connectionStatus = 'waiting'
        this.notify()
        break

      case 'kicked':
      case 'banned':
        cleanupFiles(this._state, this.notify)
        resetToHome(this._state, msg.reason ?? 'Fuiste desconectado.', this.notify)
        break

      case 'error':
        this._state.homeError = msg.message
        this.notify()
        window.setTimeout(() => {
          this._state.homeError = null
          this.notify()
        }, 5000)
        break
    }
  }
}
