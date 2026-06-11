import WebSocket from 'ws'
import type { SignalMsg, TransferMsg } from '../types'

export interface ConnectionEvents {
  onSignal(msg: SignalMsg): void
  onTransferMsg(msg: TransferMsg): void
  onBinaryChunk(data: Buffer): void
  onConnected(): void
  onDisconnected(): void
  onError(err: Error): void
}

export class ConnectionService {
  private ws: WebSocket | null = null

  constructor(private readonly events: ConnectionEvents) {}

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws?.close()
      this.ws = null

      const ws = new WebSocket(url)
      this.ws = ws

      ws.once('open', () => {
        this.events.onConnected()
        resolve()
      })

      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          this.events.onBinaryChunk(data as Buffer)
          return
        }
        let msg: SignalMsg
        try { msg = JSON.parse(data.toString()) } catch { return }
        if (msg.type === 'relay-meta') {
          this.events.onTransferMsg((msg as { type: 'relay-meta'; payload: TransferMsg }).payload)
          return
        }
        this.events.onSignal(msg)
      })

      ws.on('error', (err: Error) => {
        this.events.onError(err)
        reject(err)
      })

      ws.on('close', () => {
        this.ws = null
        this.events.onDisconnected()
      })
    })
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  sendBinary(data: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }
}
