import type {
  ConnectionStatus,
  IncomingFile,
  PeerInfo,
  TransferMessage,
} from '../shared/domain/types.js'

export type ConnectionType = 'direct' | 'turn' | 'unknown'

export interface ExpiryRuntime {
  timer?: number
  downloadsLeft?: number
  remaining?: number
}

export interface AppState {
  // ── Conexión interna ─────────────────────────────────────────
  ws: WebSocket | null
  pc: RTCPeerConnection | null
  dc: RTCDataChannel | null
  remoteDescSet: boolean
  pendingCandidates: RTCIceCandidateInit[]
  useRelay: boolean
  relayRequested: boolean
  connectTimer: number | null
  disconnectTimer: number | null

  // ── Sala ─────────────────────────────────────────────────────
  /** Pantalla actualmente visible */
  screen: 'home' | 'room'
  roomCode: string | null
  isCreator: boolean
  /** URL de invitación a la sala (solo para anfitrión) */
  shareUrl: string | null

  // ── UI derivada (sin DOM) ────────────────────────────────────
  connectionStatus: ConnectionStatus
  /** Tipo de conexión P2P: 'direct' = peer-to-peer real, 'turn' = vía servidor TURN */
  connectionType: ConnectionType
  homeError: string | null
  roomError: string | null

  // ── Peers ────────────────────────────────────────────────────
  selfInfo: PeerInfo | null
  peerInfo: PeerInfo | null
  clientsTimer: number | null

  // ── Transferencia ────────────────────────────────────────────
  fileUrls: Map<string, string>
  fileMeta: Map<string, { name: string; size?: number }>
  fileExpiry: Map<string, ExpiryRuntime>
  incoming: Map<string, IncomingFile>
}

// Puertos que el store implementa para señalización WS
export interface AppPorts {
  onSignal(msg: import('../shared/domain/types.js').SignalMessage): void | Promise<void>
  onRelayMeta(msg: TransferMessage): void
  onBinaryChunk(buffer: ArrayBuffer): void
  showHomeError(message: string): void
}

export function createAppState(): AppState {
  return {
    ws: null,
    pc: null,
    dc: null,
    remoteDescSet: false,
    pendingCandidates: [],
    useRelay: false,
    relayRequested: false,
    connectTimer: null,
    disconnectTimer: null,

    screen: 'home',
    roomCode: null,
    isCreator: false,
    shareUrl: null,

    connectionStatus: 'waiting',
    connectionType: 'unknown',
    homeError: null,
    roomError: null,

    selfInfo: null,
    peerInfo: null,
    clientsTimer: null,

    fileUrls: new Map(),
    fileMeta: new Map(),
    fileExpiry: new Map(),
    incoming: new Map(),
  }
}
