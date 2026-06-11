import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConnectionService } from './services/connection'
import { formatBytes } from './utils'
import { handleSignal } from './store/signal-handler'
import { sendFile as _sendFile, genId } from './store/file-sender'
import type {
  AppState,
  TransferMsg,
  Transfer,
  PendingDownload,
  CompletedTransfer,
  LogEntry,
  ExpiryConfig,
  ThemeName,
  TextMessage,
  TextMessageEntry,
} from './types'

export { formatBytes }

function nowTime(): string {
  return new Date().toLocaleTimeString('es', { hour12: false })
}

function makeInitialState(serverUrl: string): AppState {
  return {
    screen: 'home',
    connectionStatus: 'disconnected',
    connectionType: 'unknown',
    serverUrl,
    roomCode: null,
    isCreator: false,
    selfInfo: null,
    peerInfo: null,
    transfers: new Map(),
    pendingDownloads: [],
    completedTransfers: [],
    homeError: null,
    roomError: null,
    textMessages: new Map(),
    log: [],
    theme: 'dark',
  }
}

export class Store {
  private state: AppState
  private listeners = new Set<() => void>()
  private connection: ConnectionService
  private pendingReceiveId: string | null = null

  constructor(serverUrl: string) {
    this.state = makeInitialState(serverUrl)
    this.connection = new ConnectionService({
      onConnected: () => this.addLog('Conectado al servidor', 'success'),
      onDisconnected: () => {
        if (this.state.connectionStatus !== 'disconnected') {
          this.addLog('Desconectado del servidor', 'warning')
        }
        this.state.connectionStatus = 'disconnected'
        this.emit()
      },
      onError: (err) => {
        this.addLog(`Error de conexión: ${err.message}`, 'error')
        this.state.connectionStatus = 'disconnected'
        this.emit()
      },
      onSignal: (msg) => {
        handleSignal(this.state, msg, {
          addLog:              (m, t) => this.addLog(m, t),
          emit:                () => this.emit(),
          send:                (m) => this.connection.send(m),
          resetToHome:         () => this.resetToHome(),
          clearPendingReceive: () => { this.pendingReceiveId = null },
        })
      },
      onTransferMsg: (msg) => this.onTransferMsg(msg),
      onBinaryChunk: (data) => this.onBinaryChunk(data),
    })
  }

  get(): AppState { return this.state }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void { this.listeners.forEach((fn) => fn()) }

  private addLog(message: string, type: LogEntry['type'] = 'info'): void {
    this.state.log.unshift({ time: nowTime(), message, type })
    if (this.state.log.length > 80) this.state.log.length = 80
  }

  // ── Transfer receiving ───────────────────────────────────────────────────────

  private onTransferMsg(msg: TransferMsg): void {
    if (msg.type === 'file-start') {
      const t: Transfer = {
        fileId: msg.fileId, name: msg.name, size: msg.size,
        totalChunks: msg.totalChunks, chunks: [], received: 0,
        direction: 'receiving', startTime: Date.now(),
      }
      this.state.transfers.set(msg.fileId, t)
      this.pendingReceiveId = msg.fileId
      this.addLog(`Recibiendo: ${msg.name} (${formatBytes(msg.size)})`, 'info')
      this.emit()
      return
    }

    if (msg.type === 'file-end') {
      const t = this.state.transfers.get(msg.fileId)
      if (!t) return
      const pending: PendingDownload = {
        fileId: msg.fileId, name: t.name, size: t.size,
        mimeType: 'application/octet-stream', chunks: [...t.chunks],
      }
      this.state.pendingDownloads.push(pending)
      this.state.transfers.delete(msg.fileId)
      this.pendingReceiveId = null
      this.addLog(`Archivo listo: ${t.name} — confirma la descarga`, 'success')
      this.emit()
      return
    }

    if (msg.type === 'file-deleted') {
      this.state.transfers.delete(msg.fileId)
      this.emit()
    }

    if (msg.type === 'text-inline') {
      this.state.textMessages.set(msg.id, { message: msg, direction: 'receiving' })
      this.addLog(`Texto recibido: [${msg.format}]`, 'success')
      this.emit()
    }

    if (msg.type === 'text-deleted') {
      this.state.textMessages.delete(msg.id)
      this.addLog('Texto eliminado', 'warning')
      this.emit()
    }
  }

  private onBinaryChunk(data: Buffer): void {
    const id = this.pendingReceiveId
    if (!id) return
    const t = this.state.transfers.get(id)
    if (!t) return
    t.chunks.push(Buffer.from(data))
    t.received++
    this.emit()
  }

  private resetToHome(): void {
    this.state.screen = 'home'
    this.state.roomCode = null
    this.state.isCreator = false
    this.state.peerInfo = null
    this.state.selfInfo = null
    this.state.connectionStatus = 'disconnected'
    this.state.connectionType = 'unknown'
    this.state.transfers.clear()
    this.state.textMessages.clear()
    this.pendingReceiveId = null
    this.emit()
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async createRoom(): Promise<void> {
    this.addLog('Creando sala…', 'info')
    this.state.connectionStatus = 'connecting'
    this.emit()
    await this.connection.connect(this.state.serverUrl)
    this.state.isCreator = true
    this.connection.send({ type: 'create-room' })
  }

  async joinRoom(code: string): Promise<void> {
    const clean = code.trim().toUpperCase()
    if (clean.length !== 4) {
      this.addLog('El código debe tener exactamente 4 caracteres', 'error')
      this.state.homeError = 'El código debe tener 4 caracteres'
      this.emit()
      setTimeout(() => { this.state.homeError = null; this.emit() }, 3000)
      return
    }
    this.addLog(`Uniéndose a sala ${clean}…`, 'info')
    this.state.connectionStatus = 'connecting'
    this.emit()
    await this.connection.connect(this.state.serverUrl)
    this.state.isCreator = false
    this.connection.send({ type: 'join-room', code: clean })
  }

  async sendFile(filePath: string, expiry?: ExpiryConfig): Promise<void> {
    return _sendFile(this.state, this.connection, filePath, expiry, {
      addLog: (m, t) => this.addLog(m, t),
      emit:   () => this.emit(),
    })
  }

  acceptDownload(fileId: string): void {
    const idx = this.state.pendingDownloads.findIndex((d) => d.fileId === fileId)
    if (idx === -1) return
    const d = this.state.pendingDownloads[idx]
    this.state.pendingDownloads.splice(idx, 1)
    const buf = Buffer.concat(d.chunks)
    const savePath = path.join(os.homedir(), 'Downloads', d.name)
    try {
      fs.writeFileSync(savePath, buf)
      this.state.completedTransfers.unshift({
        fileId: d.fileId, name: d.name, size: d.size,
        direction: 'receiving', savedPath: savePath, completedAt: Date.now(),
      })
      if (this.state.completedTransfers.length > 20) this.state.completedTransfers.length = 20
      this.addLog(`Guardado: ~/Downloads/${d.name}`, 'success')
    } catch (e) {
      this.addLog(`Error al guardar: ${e}`, 'error')
    }
    this.emit()
  }

  rejectDownload(fileId: string): void {
    const idx = this.state.pendingDownloads.findIndex((d) => d.fileId === fileId)
    if (idx === -1) return
    const name = this.state.pendingDownloads[idx].name
    this.state.pendingDownloads.splice(idx, 1)
    this.addLog(`Descarga rechazada: ${name}`, 'warning')
    this.emit()
  }

  setTheme(theme: ThemeName): void {
    this.state.theme = theme
    this.emit()
  }

  leaveRoom(): void {
    this.addLog('Saliendo de la sala…', 'info')
    this.connection.disconnect()
    this.resetToHome()
  }

  sendText(content: string, format: TextMessage['format']): void {
    const msg: TextMessage = {
      type: 'text-inline',
      id: genId(),
      content,
      format,
      timestamp: new Date().toISOString(),
    }
    this.connection.send({ type: 'relay-meta', payload: msg })
    this.state.textMessages.set(msg.id, { message: msg, direction: 'sending' })
    this.addLog(`Texto enviado: [${format}]`, 'success')
    this.emit()
  }

  deleteText(id: string): void {
    this.state.textMessages.delete(id)
    this.connection.send({ type: 'relay-meta', payload: { type: 'text-deleted', id } })
    this.addLog('Texto eliminado', 'warning')
    this.emit()
  }

  copyText(id: string): string | null {
    const entry = this.state.textMessages.get(id)
    return entry ? entry.message.content : null
  }

  destroy(): void {
    this.connection.disconnect()
  }
}
