export type ConnectionStatus = 'disconnected' | 'connecting' | 'waiting' | 'relay' | 'connected'
export type ConnectionType = 'p2p' | 'relay' | 'unknown'
export type AppScreen = 'home' | 'room'
export type ThemeName = 'dark' | 'light'

export interface PeerInfo {
  ip: string
  browser: string
  mobile: boolean
  connectedAt: string | null
}

export interface ExpiryConfig {
  time?: number      // segundos
  downloads?: number
}

export interface FileStartMsg {
  type: 'file-start'
  fileId: string
  name: string
  size: number
  mimeType: string
  totalChunks: number
  expiry?: ExpiryConfig
}

export interface FileEndMsg {
  type: 'file-end'
  fileId: string
}

export interface FileDeletedMsg {
  type: 'file-deleted'
  fileId: string
}

export interface TextMessage {
  type: 'text-inline'
  id: string
  content: string
  format: 'plain' | 'json' | 'yaml' | 'html' | 'xml' | 'markdown'
  timestamp: string
}

export interface TextDeletedMessage {
  type: 'text-deleted'
  id: string
}

export interface TextMessageEntry {
  message: TextMessage
  direction: 'sending' | 'receiving'
}

export type TransferMsg = FileStartMsg | FileEndMsg | FileDeletedMsg | TextMessage | TextDeletedMessage

export type SignalMsg =
  | { type: 'room-created'; code: string }
  | { type: 'room-joined'; code: string }
  | { type: 'peer-joined' }
  | { type: 'offer'; sdp: unknown }
  | { type: 'answer'; sdp: unknown }
  | { type: 'ice-candidate'; candidate: unknown }
  | { type: 'client-info'; self: PeerInfo; peer: PeerInfo | null }
  | { type: 'peer-info'; peer: PeerInfo }
  | { type: 'relay-meta'; payload: TransferMsg }
  | { type: 'relay-mode' }
  | { type: 'retry-p2p' }
  | { type: 'peer-disconnected' }
  | { type: 'kicked'; reason?: string }
  | { type: 'banned'; reason?: string }
  | { type: 'error'; message: string }

export interface Transfer {
  fileId: string
  name: string
  size: number
  totalChunks: number
  chunks: Buffer[]
  received: number
  direction: 'sending' | 'receiving'
  startTime: number
}

export interface PendingDownload {
  fileId: string
  name: string
  size: number
  mimeType: string
  chunks: Buffer[]
}

export interface CompletedTransfer {
  fileId: string
  name: string
  size: number
  direction: 'sending' | 'receiving'
  savedPath?: string
  completedAt: number
}

export interface LogEntry {
  time: string
  message: string
  type: 'info' | 'success' | 'error' | 'warning'
}

export interface AppState {
  screen: AppScreen
  connectionStatus: ConnectionStatus
  connectionType: ConnectionType
  serverUrl: string
  roomCode: string | null
  isCreator: boolean
  selfInfo: PeerInfo | null
  peerInfo: PeerInfo | null
  transfers: Map<string, Transfer>
  pendingDownloads: PendingDownload[]
  completedTransfers: CompletedTransfer[]
  homeError: string | null
  roomError: string | null
  textMessages: Map<string, TextMessageEntry>
  log: LogEntry[]
  theme: ThemeName
}
