export type Role = 'creator' | 'joiner'
export type ConnectionStatus = 'waiting' | 'connected' | 'relay' | 'disconnected'

export interface PeerInfo {
  ip: string
  browser: string
  mobile: boolean
  connectedAt: string | null
}

export interface ExpiryConfig {
  time?: number
  downloads?: number
}

export interface FileStartMessage {
  type: 'file-start'
  fileId: string
  name: string
  size: number
  mimeType: string
  totalChunks: number
  flowControl?: boolean
  expiry?: ExpiryConfig
}

export interface FileEndMessage {
  type: 'file-end'
  fileId: string
}

export interface FileDeletedMessage {
  type: 'file-deleted'
  fileId: string
}

export interface TextMessage {
  type: 'text-inline'
  id: string
  content: string
  format: 'plain' | 'json' | 'yaml' | 'html' | 'xml' | 'markdown'
  timestamp: string
  expiry?: ExpiryConfig
}

export interface TextDeletedMessage {
  type: 'text-deleted'
  id: string
}

export interface TextMessageEntry {
  message: TextMessage
  direction: 'sending' | 'receiving'
}

export type FileReceiptMessage =
  | { type: 'file-ready' | 'file-received'; fileId: string }
  | { type: 'file-ack'; fileId: string; received: number }
  | { type: 'file-error'; fileId: string; message: string }

export interface ReceiveSink {
  write(chunk: ArrayBuffer): Promise<void>
  finish(): Promise<Blob>
  dispose(): Promise<void>
}

export type TransferMessage = FileReceiptMessage | FileStartMessage | FileEndMessage | FileDeletedMessage | TextMessage | TextDeletedMessage

export type SignalMessage =
  | { type: 'room-created'; code: string }
  | { type: 'room-joined'; code: string }
  | { type: 'peer-joined' }
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'client-info'; self: PeerInfo; peer: PeerInfo | null }
  | { type: 'peer-info'; peer: PeerInfo | null }
  | { type: 'relay-meta'; payload: TransferMessage }
  | { type: 'relay-mode' }
  | { type: 'retry-p2p' }
  | { type: 'reclaim-room'; code: string }
  | { type: 'room-reclaimed'; code: string }
  | { type: 'close-room' }
  | { type: 'room-closed'; reason?: string }
  | { type: 'peer-disconnected' }
  | { type: 'kicked'; reason?: string }
  | { type: 'banned'; reason?: string }
  | { type: 'error'; message: string }

// Archivo en vuelo. Sin referencias al DOM — el progreso se sigue con `received`.
export interface IncomingFile {
  meta: FileStartMessage
  chunks: ArrayBuffer[]
  received: number
  bytes?: number
  pendingBytes?: number
  queue?: Promise<void>
  sink?: Promise<ReceiveSink>
  finishing?: boolean
  ready?: boolean
  acked?: number
  confirmed?: boolean
  error?: string
  direction?: 'sending' | 'receiving'
}
