import type { IncomingFile, PeerInfo, SignalMessage, TransferMessage } from '../shared/domain/types.js';

export interface ExpiryRuntime {
  timer?: number;
  downloadsLeft?: number;
}

export interface AppState {
  ws: WebSocket | null;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  isCreator: boolean;
  remoteDescSet: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  useRelay: boolean;
  relayRequested: boolean;
  connectTimer: number | null;
  disconnectTimer: number | null;
  selfInfo: PeerInfo | null;
  peerInfo: PeerInfo | null;
  clientsTimer: number | null;
  fileUrls: Map<string, string>;
  fileExpiry: Map<string, ExpiryRuntime>;
  incoming: Map<string, IncomingFile>;
}

export interface AppPorts {
  onSignal(msg: SignalMessage): void | Promise<void>;
  onRelayMeta(msg: TransferMessage): void;
  onBinaryChunk(buffer: ArrayBuffer): void;
  showHomeError(message: string): void;
}

export function createAppState(): AppState {
  return {
    ws: null,
    pc: null,
    dc: null,
    isCreator: false,
    remoteDescSet: false,
    pendingCandidates: [],
    useRelay: false,
    relayRequested: false,
    connectTimer: null,
    disconnectTimer: null,
    selfInfo: null,
    peerInfo: null,
    clientsTimer: null,
    fileUrls: new Map(),
    fileExpiry: new Map(),
    incoming: new Map(),
  };
}
