import type { AppState, ExpiryRuntime } from '@client/app/state'
import type { ExpiryConfig, IncomingFile, TransferMessage } from '@shared/domain/types'
import { sendMeta } from '@features/connection/application/webrtc'
import { createReceiveSink, MAX_FILE_BYTES } from './storage'

const CHUNK_SIZE = 128 * 1024
const WINDOW = 8

function generateId(): string {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function sendFiles(state: AppState, files: File[], expiry: ExpiryConfig | null, notify: () => void, onError?: (msg: string) => void): Promise<void> {
  for (const file of files) {
    try { await sendFile(state, file, expiry, notify) } catch (err) {
      onError?.(`Error al enviar: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }
}

async function sendFile(state: AppState, file: File, expiry: ExpiryConfig | null, notify: () => void): Promise<void> {
  if (!Number.isSafeInteger(MAX_FILE_BYTES) || MAX_FILE_BYTES < 1 || file.size > MAX_FILE_BYTES) throw new Error('El archivo supera el límite configurado.')
  const dc = !state.useRelay && state.dc?.readyState === 'open' ? state.dc : null
  const ws = state.ws
  if (!dc && (!ws || ws.readyState !== WebSocket.OPEN)) throw new Error('La conexión se perdió. Reconéctate e intenta de nuevo.')
  if (!dc) state.useRelay = true
  const fileId = generateId()
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const entry: IncomingFile = {
    meta: { type: 'file-start', fileId, name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream', totalChunks, flowControl: true, ...(expiry ? { expiry } : {}) },
    chunks: [], received: 0, direction: 'sending', acked: 0,
  }
  state.incoming.set(fileId, entry)
  notify()
  const ensureOpen = () => {
    if (entry.error) throw new Error(entry.error)
    if (state.incoming.get(fileId) !== entry) throw new Error('Transferencia cancelada.')
    if (dc ? dc.readyState !== 'open' : !ws || ws.readyState !== WebSocket.OPEN) throw new Error('La conexión se perdió durante el envío.')
  }
  const send = (msg: TransferMessage | ArrayBuffer) => {
    ensureOpen()
    if (dc) {
      if (msg instanceof ArrayBuffer) dc.send(msg)
      else dc.send(JSON.stringify(msg))
    } else if (ws) {
      if (msg instanceof ArrayBuffer) ws.send(msg)
      else ws.send(JSON.stringify({ type: 'relay-meta', payload: msg }))
    }
  }
  async function waitUntil(check: () => boolean, timeout = 60000, optional = false): Promise<boolean> {
    let lastAck = entry.acked
    let deadline = Date.now() + timeout
    while (!check()) {
      ensureOpen()
      if (lastAck !== entry.acked) { lastAck = entry.acked; deadline = Date.now() + timeout }
      if (Date.now() >= deadline) {
        if (optional) return false
        throw new Error('El destinatario o la conexión dejaron de responder.')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    ensureOpen()
    return true
  }
  try {
    send(entry.meta)
    await waitUntil(() => !!entry.ready, file.size > 64 * 1024 ** 2 ? 30000 : 2000, file.size <= 64 * 1024 ** 2)
    for (let i = 0; i < totalChunks; i++) {
      if (entry.ready) await waitUntil(() => i - (entry.acked ?? 0) < WINDOW)
      await waitUntil(() => (dc ? dc.bufferedAmount : ws!.bufferedAmount) <= 1024 * 1024)
      // Read only one fragment, for both P2P and relay.
      const chunk = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer()
      send(chunk)
      entry.received = i + 1
      if (i % WINDOW === WINDOW - 1) notify()
    }
    if (entry.ready) await waitUntil(() => entry.acked === totalChunks)
    send({ type: 'file-end', fileId })
    if (entry.ready) await waitUntil(() => !!entry.confirmed)
    else await waitUntil(() => (dc ? dc.bufferedAmount : ws!.bufferedAmount) === 0)
    state.fileMeta.set(fileId, { name: file.name, size: file.size })
    if (expiry?.time) startExpiryTimer(state, fileId, expiry.time, notify)
    if (expiry?.downloads) startDownloadLimit(state, fileId, expiry.downloads)
  } catch (err) {
    try { send({ type: 'file-error', fileId, message: err instanceof Error ? err.message : String(err) }) } catch {}
    throw err
  } finally {
    state.incoming.delete(fileId)
    notify()
  }
}

function failReceive(state: AppState, entry: IncomingFile, error: unknown, notify: () => void): void {
  if (entry.error) return
  entry.error = error instanceof Error && error.name === 'QuotaExceededError'
    ? 'No hay suficiente espacio disponible en el almacenamiento del navegador.'
    : error instanceof Error ? error.message : String(error)
  state.roomError = `Error al recibir: ${entry.error}`
  if (entry.meta.flowControl) sendMeta(state, { type: 'file-error', fileId: entry.meta.fileId, message: entry.error })
  deleteFile(state, entry.meta.fileId, false, notify)
}

export function handleMetaMessage(state: AppState, msg: TransferMessage, notify: () => void): void {
  if (msg.type === 'file-ready' || msg.type === 'file-ack' || msg.type === 'file-received' || msg.type === 'file-error') {
    const entry = state.incoming.get(msg.fileId)
    if (!entry) return
    if (msg.type === 'file-error') {
      if (entry.direction === 'sending') entry.error = msg.message
      else failReceive(state, entry, new Error(msg.message), notify)
    } else if (entry.direction === 'sending') {
      if (msg.type === 'file-ready') entry.ready = true
      if (msg.type === 'file-received') entry.confirmed = true
      if (msg.type === 'file-ack' && Number.isSafeInteger(msg.received) && msg.received >= 0 && msg.received <= entry.meta.totalChunks) entry.acked = Math.max(entry.acked ?? 0, msg.received)
    }
    return
  }
  if (msg.type === 'file-start') {
    // The binary protocol supports one receiving file at a time.
    if (state.incoming.has(msg.fileId) || [...state.incoming.values()].some(e => e.direction === 'receiving' && !e.finishing)) {
      sendMeta(state, { type: 'file-error', fileId: msg.fileId, message: 'Transferencias simultáneas no soportadas.' })
      return
    }
    if (!Number.isSafeInteger(MAX_FILE_BYTES) || MAX_FILE_BYTES < 1 || typeof msg.fileId !== 'string' || typeof msg.name !== 'string' || !Number.isSafeInteger(msg.size) || msg.size < 0 || msg.size > MAX_FILE_BYTES || !Number.isSafeInteger(msg.totalChunks) || msg.totalChunks < 0 || msg.totalChunks > Math.max(1, msg.size) || (msg.size > 0 && msg.totalChunks === 0)) {
      state.roomError = 'Metadatos de archivo inválidos o tamaño superior al límite.'
      sendMeta(state, { type: 'file-error', fileId: msg.fileId, message: state.roomError })
      notify()
      return
    }
    const entry: IncomingFile = { meta: msg, chunks: [], received: 0, bytes: 0, pendingBytes: 0, direction: 'receiving', sink: createReceiveSink(msg.size, msg.mimeType) }
    state.incoming.set(msg.fileId, entry)
    entry.queue = entry.sink!.then(() => {
      if (state.incoming.get(msg.fileId) === entry && msg.flowControl) sendMeta(state, { type: 'file-ready', fileId: msg.fileId })
    }).catch(error => failReceive(state, entry, error, notify))
    notify()
    return
  }
  if (msg.type === 'file-end') {
    const entry = state.incoming.get(msg.fileId)
    if (!entry || entry.direction !== 'receiving' || entry.finishing) return
    entry.finishing = true
    if (entry.received !== entry.meta.totalChunks || entry.bytes !== entry.meta.size) {
      failReceive(state, entry, new Error('Archivo incompleto.'), notify)
      return
    }
    entry.queue = (entry.queue ?? Promise.resolve()).then(async () => {
      if (state.incoming.get(msg.fileId) !== entry) return
      const sink = await entry.sink!
      const blob = await sink.finish()
      if (state.incoming.get(msg.fileId) !== entry) { await sink.dispose(); return }
      state.fileUrls.set(msg.fileId, URL.createObjectURL(blob))
      state.fileDisposers.set(msg.fileId, () => sink.dispose())
      state.fileMeta.set(msg.fileId, { name: entry.meta.name, size: entry.meta.size })
      const expiry = entry.meta.expiry
      if (expiry?.time) startExpiryTimer(state, msg.fileId, expiry.time, notify)
      if (expiry?.downloads) startDownloadLimit(state, msg.fileId, expiry.downloads)
      if (entry.meta.flowControl) sendMeta(state, { type: 'file-received', fileId: msg.fileId })
      state.incoming.delete(msg.fileId)
      notify()
    }).catch(error => failReceive(state, entry, error, notify))
    return
  }
  if (msg.type === 'file-deleted') deleteFile(state, msg.fileId, false, notify)
}

export function handleChunk(state: AppState, buffer: ArrayBuffer, notify: () => void): void {
  const entry = [...state.incoming.values()].find(e => e.direction === 'receiving' && !e.finishing)
  if (!entry) return
  if (entry.received >= entry.meta.totalChunks || (entry.bytes ?? 0) + buffer.byteLength > entry.meta.size || (entry.pendingBytes ?? 0) + buffer.byteLength > 4 * 1024 ** 2) {
    failReceive(state, entry, new Error('El archivo supera los límites declarados o el emisor no espera al almacenamiento.'), notify)
    return
  }
  const received = ++entry.received
  entry.bytes = (entry.bytes ?? 0) + buffer.byteLength
  entry.pendingBytes = (entry.pendingBytes ?? 0) + buffer.byteLength
  entry.queue = (entry.queue ?? Promise.resolve()).then(async () => {
    if (state.incoming.get(entry.meta.fileId) !== entry) return
    await (await entry.sink!).write(buffer)
    entry.pendingBytes = (entry.pendingBytes ?? 0) - buffer.byteLength
    if (entry.meta.flowControl && (received % WINDOW === 0 || received === entry.meta.totalChunks)) sendMeta(state, { type: 'file-ack', fileId: entry.meta.fileId, received })
    if (received % WINDOW === 0 || received === entry.meta.totalChunks) notify()
  }).catch(error => failReceive(state, entry, error, notify))
}

// ── Borrado y limpieza ───────────────────────────────────────────────────────

export function deleteFile(
  state: AppState,
  fileId: string,
  notifyPeer: boolean,
  notify: () => void,
): void {
  const url = state.fileUrls.get(fileId)
  if (url) URL.revokeObjectURL(url)
  state.fileUrls.delete(fileId)
  state.fileMeta.delete(fileId)
  const expiry = state.fileExpiry.get(fileId)
  if (expiry?.timer) window.clearInterval(expiry.timer)
  state.fileExpiry.delete(fileId)
  const active = state.incoming.get(fileId)
  state.incoming.delete(fileId)
  if (active?.sink) void (active.queue ?? Promise.resolve()).then(async () => (await active.sink!).dispose()).catch(() => undefined)
  const dispose = state.fileDisposers.get(fileId)
  state.fileDisposers.delete(fileId)
  if (dispose) void dispose().catch(() => undefined)
  if (notifyPeer) sendMeta(state, { type: 'file-deleted', fileId })
  notify()
}

export function cleanupFiles(state: AppState, notify: () => void): void {
  state.fileUrls.forEach((url) => URL.revokeObjectURL(url))
  state.fileUrls.clear()
  state.fileMeta.clear()
  state.fileExpiry.forEach((entry) => {
    if (entry.timer) window.clearInterval(entry.timer)
  })
  state.fileExpiry.clear()
  for (const id of [...state.incoming.keys(), ...state.fileDisposers.keys()]) deleteFile(state, id, false, () => {})
  state.incoming.clear()
  notify()
}

export function recordDownload(state: AppState, fileId: string, notify: () => void): void {
  const entry = state.fileExpiry.get(fileId)
  if (!entry) return
  entry.downloadsLeft = (entry.downloadsLeft ?? 1) - 1
  state.fileExpiry.set(fileId, { ...entry })
  if ((entry.downloadsLeft ?? 0) <= 0) {
    window.setTimeout(() => deleteFile(state, fileId, true, notify), 300)
  }
  notify()
}

// ── Utilidades de formato (sin DOM) ─────────────────────────────────────────

export function fileIconType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  const icons: Record<string, string> = {
    pdf: 'doc',
    zip: 'zip',
    tar: 'zip',
    gz: 'zip',
    rar: 'zip',
    jpg: 'img',
    jpeg: 'img',
    png: 'img',
    gif: 'img',
    webp: 'img',
    svg: 'img',
    mp4: 'mov',
    mkv: 'mov',
    mov: 'mov',
    avi: 'mov',
    mp3: 'aud',
    wav: 'aud',
    flac: 'aud',
    js: 'code',
    ts: 'code',
    json: 'code',
    html: 'code',
    css: 'code',
    txt: 'txt',
    md: 'md',
    dmg: 'app',
    exe: 'app',
  }
  return ext ? (icons[ext] ?? 'file') : 'file'
}

// ── Internos ─────────────────────────────────────────────────────────────────

function startExpiryTimer(
  state: AppState,
  fileId: string,
  seconds: number,
  notify: () => void,
): void {
  let remaining = seconds
  const runtime: ExpiryRuntime = { remaining, ...state.fileExpiry.get(fileId) }
  const timer = window.setInterval(() => {
    remaining--
    const entry = state.fileExpiry.get(fileId)
    if (entry) {
      entry.remaining = remaining
      state.fileExpiry.set(fileId, { ...entry })
    }
    notify()
    if (remaining <= 0) {
      window.clearInterval(timer)
      deleteFile(state, fileId, true, notify)
    }
  }, 1000)
  state.fileExpiry.set(fileId, { ...runtime, timer })
}

function startDownloadLimit(state: AppState, fileId: string, maxDownloads: number): void {
  state.fileExpiry.set(fileId, {
    ...state.fileExpiry.get(fileId),
    downloadsLeft: maxDownloads,
  })
}
