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

export type TransferMessage = FileStartMessage | FileEndMessage | FileDeletedMessage

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
  | { type: 'peer-disconnected' }
  | { type: 'kicked'; reason?: string }
  | { type: 'banned'; reason?: string }
  | { type: 'error'; message: string }

// Archivo en vuelo. Sin referencias al DOM — el progreso se sigue con `received`.
export interface IncomingFile {
  meta: FileStartMessage
  chunks: ArrayBuffer[]
  received: number
  direction?: 'sending' | 'receiving'
}
