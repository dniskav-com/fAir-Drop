import type { AppState } from '../../../app/state.js';
import type { TransferMessage } from '../../../shared/domain/types.js';
import { wsSend } from './signaling.js';

const CONNECT_TIMEOUT_MS = 9000;
const DISCONNECT_GRACE_MS = 3500;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export interface WebRtcPorts {
  setStatus(state: 'waiting' | 'connected' | 'relay' | 'disconnected'): void;
  enableDropZone(): void;
  disableDropZone(): void;
  handleMetaMessage(msg: TransferMessage): void;
  handleChunk(buffer: ArrayBuffer): void;
}

export async function startPeerConnection(
  state: AppState,
  ports: WebRtcPorts,
  asInitiator: boolean,
): Promise<void> {
  clearConnectionTimers(state);
  state.remoteDescSet = false;
  state.pendingCandidates = [];
  state.relayRequested = false;
  state.pc?.close();

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.pc = pc;
  console.log('[RTC] PeerConnection creado, rol:', asInitiator ? 'creador' : 'invitado');

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      wsSend(state, { type: 'ice-candidate', candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const iceState = pc.iceConnectionState;
    console.log('[ICE] estado:', iceState);
    if (iceState === 'failed') switchToRelay(state, ports);
    if (iceState === 'disconnected') {
      state.disconnectTimer = window.setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') switchToRelay(state, ports);
      }, DISCONNECT_GRACE_MS);
    }
    if (iceState === 'connected' || iceState === 'completed') {
      clearTimer(state.disconnectTimer);
      state.disconnectTimer = null;
    }
  };

  pc.onconnectionstatechange = () => {
    const connectionState = pc.connectionState;
    console.log('[RTC] connectionState:', connectionState);
    if (connectionState === 'connected') {
      clearConnectionTimers(state);
      ports.setStatus('connected');
      ports.enableDropZone();
      return;
    }
    if (connectionState === 'failed') switchToRelay(state, ports);
    if (connectionState === 'closed' && !state.useRelay) {
      ports.setStatus('disconnected');
      ports.disableDropZone();
    }
  };

  state.connectTimer = window.setTimeout(() => {
    if (!state.useRelay && state.pc?.connectionState !== 'connected') {
      console.warn('[fAir Drop] P2P tardo demasiado, cambiando a relay');
      switchToRelay(state, ports);
    }
  }, CONNECT_TIMEOUT_MS);

  if (asInitiator) {
    const channel = pc.createDataChannel('fairdrop', { ordered: true });
    setupDataChannel(state, ports, channel);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend(state, { type: 'offer', sdp: pc.localDescription });
  } else {
    pc.ondatachannel = event => setupDataChannel(state, ports, event.channel);
  }
}

export async function applyRemoteAnswer(state: AppState, sdp: RTCSessionDescriptionInit): Promise<void> {
  if (!state.pc) return;
  await state.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  state.remoteDescSet = true;
  await flushPendingCandidates(state);
}

export async function acceptOffer(
  state: AppState,
  ports: WebRtcPorts,
  sdp: RTCSessionDescriptionInit,
): Promise<void> {
  await startPeerConnection(state, ports, false);
  if (!state.pc) return;
  await state.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  state.remoteDescSet = true;
  await flushPendingCandidates(state);
  const answer = await state.pc.createAnswer();
  await state.pc.setLocalDescription(answer);
  wsSend(state, { type: 'answer', sdp: state.pc.localDescription });
}

export async function addIceCandidate(state: AppState, candidate: RTCIceCandidateInit): Promise<void> {
  if (state.pc && state.remoteDescSet) {
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[ICE] addIceCandidate fallo:', err);
    }
  } else {
    state.pendingCandidates.push(candidate);
  }
}

export function switchToRelay(state: AppState, ports: WebRtcPorts): void {
  if (state.useRelay || state.relayRequested) return;
  state.useRelay = true;
  state.relayRequested = true;
  clearConnectionTimers(state);
  state.pc?.close();
  state.pc = null;
  state.dc = null;
  wsSend(state, { type: 'relay-mode' });
  ports.setStatus('relay');
  ports.enableDropZone();
}

export function relaySend(state: AppState, data: TransferMessage | ArrayBuffer): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  if (data instanceof ArrayBuffer) {
    state.ws.send(data);
  } else {
    state.ws.send(JSON.stringify({ type: 'relay-meta', payload: data }));
  }
}

export function sendMeta(state: AppState, data: TransferMessage): void {
  if (state.useRelay) {
    relaySend(state, data);
  } else if (state.dc?.readyState === 'open') {
    state.dc.send(JSON.stringify(data));
  }
}

function setupDataChannel(state: AppState, ports: WebRtcPorts, channel: RTCDataChannel): void {
  state.dc = channel;
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    clearConnectionTimers(state);
    ports.setStatus('connected');
    ports.enableDropZone();
  };
  channel.onclose = () => {
    if (!state.useRelay) {
      ports.setStatus('disconnected');
      ports.disableDropZone();
    }
  };
  channel.onmessage = event => {
    if (typeof event.data === 'string') {
      ports.handleMetaMessage(JSON.parse(event.data));
    } else {
      ports.handleChunk(event.data);
    }
  };
}

async function flushPendingCandidates(state: AppState): Promise<void> {
  if (!state.pc) return;
  const pending = [...state.pendingCandidates];
  state.pendingCandidates = [];
  for (const candidate of pending) {
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[ICE] flush fallo:', err);
    }
  }
}

function clearConnectionTimers(state: AppState): void {
  clearTimer(state.connectTimer);
  clearTimer(state.disconnectTimer);
  state.connectTimer = null;
  state.disconnectTimer = null;
}

function clearTimer(timer: number | null): void {
  if (timer) window.clearTimeout(timer);
}
