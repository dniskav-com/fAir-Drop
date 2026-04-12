import type { AppState, ExpiryRuntime } from '@client/app/state'
import type { ExpiryConfig, FileStartMessage, TransferMessage } from '@shared/domain/types'
import { relaySend, sendMeta } from '@features/connection/application/webrtc'

const CHUNK_SIZE = 16 * 1024

// crypto.randomUUID() requiere contexto seguro (HTTPS/localhost); fallback para HTTP en LAN
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ── Envío ────────────────────────────────────────────────────────────────────

export async function sendFiles(
  state: AppState,
  files: File[],
  expiry: ExpiryConfig | null,
  notify: () => void,
  onError?: (msg: string) => void,
): Promise<void> {
  for (const file of files) {
    try {
      await sendFile(state, file, expiry, notify)
    } catch (err) {
      if (err instanceof Error && err.message === 'no-transport') {
        onError?.('La conexión se perdió. Reconéctate e intenta de nuevo.')
        return
      }
      onError?.(`Error al enviar: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }
}

async function sendFile(
  state: AppState,
  file: File,
  expiry: ExpiryConfig | null,
  notify: () => void,
): Promise<void> {
  const fileId = generateId()
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const meta: FileStartMessage = {
    type: 'file-start',
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
    ...(expiry ? { expiry } : {}),
  }

  state.incoming.set(fileId, { meta, chunks: [], received: 0, direction: 'sending' })
  state.fileMeta.set(fileId, { name: file.name, size: file.size })
  notify()

  const buffer = await file.arrayBuffer()

  if (state.useRelay) {
    relaySend(state, meta)
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      relaySend(state, buffer.slice(start, start + CHUNK_SIZE))
      const entry = state.incoming.get(fileId)
      if (entry) entry.received = i + 1
      if (i % 20 === 19) {
        notify()
        await new Promise(requestAnimationFrame)
      }
    }
    relaySend(state, { type: 'file-end', fileId })
  } else if (state.dc?.readyState === 'open') {
    state.dc.send(JSON.stringify(meta))
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      state.dc.send(buffer.slice(start, start + CHUNK_SIZE))
      const entry = state.incoming.get(fileId)
      if (entry) entry.received = i + 1
      if (state.dc.bufferedAmount > 1024 * 1024) await waitForBuffer(state)
    }
    state.dc.send(JSON.stringify({ type: 'file-end', fileId }))
  } else if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    // Fallback automático a relay si la DataChannel no está disponible pero
    // la conexión WebSocket al servidor está abierta. Esto evita fallos
    // de envío en entornos NAT restrictivos sin necesidad de TURN.
    state.useRelay = true
    relaySend(state, meta)
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      relaySend(state, buffer.slice(start, start + CHUNK_SIZE))
      const entry = state.incoming.get(fileId)
      if (entry) entry.received = i + 1
      if (i % 20 === 19) {
        notify()
        await new Promise(requestAnimationFrame)
      }
    }
    relaySend(state, { type: 'file-end', fileId })
  } else {
    state.incoming.delete(fileId)
    state.fileMeta.delete(fileId)
    notify()
    throw new Error('no-transport')
  }

  const finalEntry = state.incoming.get(fileId)
  if (finalEntry) finalEntry.received = totalChunks
  state.incoming.delete(fileId)

  if (expiry?.time) startExpiryTimer(state, fileId, expiry.time, notify)
  if (expiry?.downloads) startDownloadLimit(state, fileId, expiry.downloads)

  notify()
}

// ── Recepción ────────────────────────────────────────────────────────────────

export function handleMetaMessage(state: AppState, msg: TransferMessage, notify: () => void): void {
  if (msg.type === 'file-start') {
    state.incoming.set(msg.fileId, { meta: msg, chunks: [], received: 0, direction: 'receiving' })
    notify()
    return
  }

  if (msg.type === 'file-end') {
    const entry = state.incoming.get(msg.fileId)
    if (!entry) return
    const blob = new Blob(entry.chunks, { type: entry.meta.mimeType })
    const url = URL.createObjectURL(blob)
    state.fileUrls.set(msg.fileId, url)
    state.fileMeta.set(msg.fileId, { name: entry.meta.name, size: entry.meta.size })
    const expiry = entry.meta.expiry ?? null
    if (expiry?.time) startExpiryTimer(state, msg.fileId, expiry.time, notify)
    if (expiry?.downloads) startDownloadLimit(state, msg.fileId, expiry.downloads)
    state.incoming.delete(msg.fileId)
    notify()
    return
  }

  if (msg.type === 'file-deleted') {
    deleteFile(state, msg.fileId, false, notify)
  }
}

export function handleChunk(state: AppState, buffer: ArrayBuffer, notify: () => void): void {
  for (const [, entry] of state.incoming) {
    if (entry.received < entry.meta.totalChunks) {
      entry.chunks.push(buffer)
      entry.received++
      notify()
      break
    }
  }
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
  state.incoming.delete(fileId)
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

function waitForBuffer(state: AppState): Promise<void> {
  return new Promise((resolve) => {
    const check = window.setInterval(() => {
      if (!state.dc || state.dc.bufferedAmount < 256 * 1024) {
        window.clearInterval(check)
        resolve()
      }
    }, 50)
  })
}

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
