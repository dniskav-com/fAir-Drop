import type { AppState } from '../../../app/state.js'
import type {
  ExpiryConfig,
  FileStartMessage,
  TransferMessage
} from '../../../shared/domain/types.js'
import { escapeHtml, formatBytes } from '../../../shared/application/format.js'
import { relaySend, sendMeta } from '../../connection/application/webrtc.js'

const CHUNK_SIZE = 16 * 1024

// crypto.randomUUID() requires secure context (HTTPS/localhost); fallback for HTTP LAN
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export interface TransferDom {
  fileListSection: HTMLElement
  fileList: HTMLUListElement
  expTimeOn: HTMLInputElement
  expTimeVal: HTMLInputElement
  expDlOn: HTMLInputElement
  expDlVal: HTMLInputElement
}

export async function sendFiles(state: AppState, dom: TransferDom, files: File[], onError?: (msg: string) => void): Promise<void> {
  for (const file of files) {
    try {
      await sendFile(state, dom, file)
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

// React-friendly API: accept files directly and an optional expiry config.
export async function sendFilesReact(
  state: AppState,
  files: File[],
  expiryConfig?: { time?: number; downloads?: number }
): Promise<void> {
  // We pass a dummy dom object because addFileItem only uses dom when uiReact is false.
  const dummyDom = {
    fileListSection: document.createElement('div'),
    fileList: document.createElement('ul'),
    expTimeOn: document.createElement('input'),
    expTimeVal: document.createElement('input'),
    expDlOn: document.createElement('input'),
    expDlVal: document.createElement('input')
  } as unknown as TransferDom

  for (const file of files) {
    // call the internal sendFile flow but emulate the expiry inputs when needed
    await sendFileReact(state, dummyDom, file, expiryConfig)
  }
}

async function sendFileReact(
  state: AppState,
  dom: TransferDom,
  file: File,
  expiryConfig?: { time?: number; downloads?: number }
): Promise<void> {
  const fileId = generateId()
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const expiry = expiryConfig ?? null
  const meta: FileStartMessage = {
    type: 'file-start',
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
    ...(expiry ? { expiry } : {})
  }
  const itemEl = addFileItem(state, dom, {
    id: fileId,
    name: file.name,
    size: file.size,
    direction: 'sending',
    totalChunks
  })
  state.incoming.set(fileId, { meta, chunks: [], received: 0, itemEl, direction: 'sending' })
  state.fileMeta.set(fileId, { name: file.name, size: file.size })
  const buffer = await file.arrayBuffer()

  if (state.useRelay) {
    relaySend(state, meta)
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      relaySend(state, buffer.slice(start, start + CHUNK_SIZE))
      const entry = state.incoming.get(fileId)
      if (entry) entry.received = i + 1
      updateProgress(itemEl, i + 1, totalChunks)
      if (i % 20 === 19) await new Promise(requestAnimationFrame)
    }
    relaySend(state, { type: 'file-end', fileId })
  } else if (state.dc?.readyState === 'open') {
    state.dc.send(JSON.stringify(meta))
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      state.dc.send(buffer.slice(start, start + CHUNK_SIZE))
      const entry = state.incoming.get(fileId)
      if (entry) entry.received = i + 1
      updateProgress(itemEl, i + 1, totalChunks)
      if (state.dc.bufferedAmount > 1024 * 1024) await waitForBuffer(state)
    }
    state.dc.send(JSON.stringify({ type: 'file-end', fileId }))
  }

  const finalEntry = state.incoming.get(fileId)
  if (finalEntry) finalEntry.received = totalChunks

  markDone(state, dom, itemEl, null, expiry)
  if (expiry?.time) startExpiryTimer(state, dom, fileId, expiry.time)
  if (state.incoming.has(fileId)) {
    state.incoming.delete(fileId)
  }
}

export function handleMetaMessage(state: AppState, dom: TransferDom, msg: TransferMessage): void {
  if (msg.type === 'file-start') {
    const itemEl = addFileItem(state, dom, {
      id: msg.fileId,
      name: msg.name,
      size: msg.size,
      direction: 'receiving',
      totalChunks: msg.totalChunks
    })
    state.incoming.set(msg.fileId, { meta: msg, chunks: [], received: 0, itemEl })
    return
  }

  if (msg.type === 'file-end') {
    const entry = state.incoming.get(msg.fileId)
    if (!entry) return
    const blob = new Blob(entry.chunks, { type: entry.meta.mimeType })
    const url = URL.createObjectURL(blob)
    state.fileUrls.set(msg.fileId, url)
    const expiry = entry.meta.expiry ?? null
    if (!entry.itemEl) return
    markDone(state, dom, entry.itemEl, { url, name: entry.meta.name, fileId: msg.fileId }, expiry)
    if (expiry?.time) startExpiryTimer(state, dom, msg.fileId, expiry.time)
    if (expiry?.downloads) startDownloadLimit(state, dom, msg.fileId, expiry.downloads)
    state.incoming.delete(msg.fileId)
    return
  }

  if (msg.type === 'file-deleted') {
    deleteFileItem(state, dom, msg.fileId, false)
  }
}

export function handleChunk(state: AppState, buffer: ArrayBuffer): void {
  for (const [, entry] of state.incoming) {
    if (entry.received < entry.meta.totalChunks) {
      entry.chunks.push(buffer)
      entry.received++
      if (entry.itemEl) updateProgress(entry.itemEl, entry.received, entry.meta.totalChunks)
      break
    }
  }
}

export function deleteFileItem(
  state: AppState,
  dom: TransferDom,
  fileId: string,
  notifyPeer: boolean
): void {
  // Keep state updated; if React UI is present, avoid DOM mutation
  const url = state.fileUrls.get(fileId)
  if (url) URL.revokeObjectURL(url)
  state.fileUrls.delete(fileId)
  state.fileMeta.delete(fileId)
  const expiry = state.fileExpiry.get(fileId)
  if (expiry?.timer) window.clearInterval(expiry.timer)
  state.fileExpiry.delete(fileId)
  if (!state.uiReact) {
    const li = dom.fileList.querySelector<HTMLLIElement>(`[data-file-id="${fileId}"]`)
    li?.remove()
    if (dom.fileList.children.length === 0) dom.fileListSection.classList.add('hidden')
  }
  if (notifyPeer) sendMeta(state, { type: 'file-deleted', fileId })
}

export function cleanupFiles(state: AppState, dom: TransferDom): void {
  state.fileUrls.forEach((url) => URL.revokeObjectURL(url))
  state.fileUrls.clear()
  state.fileMeta.clear()
  state.fileExpiry.forEach((entry) => {
    if (entry.timer) window.clearInterval(entry.timer)
  })
  state.fileExpiry.clear()
  state.incoming.clear()
  if (!state.uiReact) {
    dom.fileList.innerHTML = ''
    dom.fileListSection.classList.add('hidden')
  }
}

async function sendFile(state: AppState, dom: TransferDom, file: File): Promise<void> {
  const fileId = generateId()
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const expiry = getExpiryConfig(dom)
  const meta: FileStartMessage = {
    type: 'file-start',
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
    ...(expiry ? { expiry } : {})
  }
  // create DOM entry for legacy UI and register the outgoing file in AppState
  const itemEl = addFileItem(state, dom, {
    id: fileId,
    name: file.name,
    size: file.size,
    direction: 'sending',
    totalChunks
  })
  state.incoming.set(fileId, { meta, chunks: [], received: 0, itemEl, direction: 'sending' })
  state.fileMeta.set(fileId, { name: file.name, size: file.size })
  const buffer = await file.arrayBuffer()

  if (state.useRelay) {
    relaySend(state, meta)
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      relaySend(state, buffer.slice(start, start + CHUNK_SIZE))
      // update both DOM progress and state so React list reflects progress
      const entry = state.incoming.get(fileId)
      if (entry) entry.received = i + 1
      updateProgress(itemEl, i + 1, totalChunks)
      if (i % 20 === 19) await new Promise(requestAnimationFrame)
    }
    relaySend(state, { type: 'file-end', fileId })
  } else if (state.dc?.readyState === 'open') {
    state.dc.send(JSON.stringify(meta))
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      state.dc.send(buffer.slice(start, start + CHUNK_SIZE))
      const entry = state.incoming.get(fileId)
      if (entry) entry.received = i + 1
      updateProgress(itemEl, i + 1, totalChunks)
      if (state.dc.bufferedAmount > 1024 * 1024) await waitForBuffer(state)
    }
    state.dc.send(JSON.stringify({ type: 'file-end', fileId }))
  } else {
    // Sin transporte disponible: limpiar el ítem agregado y abortar
    state.incoming.delete(fileId)
    state.fileMeta.delete(fileId)
    if (!state.uiReact) {
      itemEl.remove()
      if (dom.fileList.children.length === 0) dom.fileListSection.classList.add('hidden')
    }
    throw new Error('no-transport')
  }
  // ensure final progress is reflected in state
  const finalEntry = state.incoming.get(fileId)
  if (finalEntry) finalEntry.received = totalChunks

  markDone(state, dom, itemEl, null, expiry)
  if (expiry?.time) startExpiryTimer(state, dom, fileId, expiry.time)
  // For sender: move entry out of incoming so React shows it as completed (metadata retained)
  if (state.incoming.has(fileId)) {
    state.incoming.delete(fileId)
  }
}

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

function getExpiryConfig(dom: TransferDom): ExpiryConfig | null {
  const cfg: ExpiryConfig = {}
  if (dom.expTimeOn.checked) cfg.time = Math.max(1, Number.parseInt(dom.expTimeVal.value, 10) || 30)
  if (dom.expDlOn.checked) cfg.downloads = Math.max(1, Number.parseInt(dom.expDlVal.value, 10) || 1)
  return cfg.time || cfg.downloads ? cfg : null
}

function addFileItem(
  state: AppState,
  dom: TransferDom,
  data: {
    id: string
    name: string
    size: number
    direction: 'sending' | 'receiving'
    totalChunks: number
  }
): HTMLLIElement {
  // If React UI is mounted, avoid direct DOM mutations; return a lightweight placeholder
  if (state.uiReact) {
    const li = document.createElement('li')
    li.className = 'file-item'
    li.dataset.fileId = data.id
    return li
  }
  dom.fileListSection.classList.remove('hidden')
  const li = document.createElement('li')
  li.className = 'file-item'
  li.dataset.fileId = data.id
  li.innerHTML = `
    <span class="file-icon">${fileIcon(data.name)}</span>
    <div class="file-meta">
      <div class="file-name">${escapeHtml(data.name)}</div>
      <div class="file-size">${formatBytes(data.size)}</div>
      ${data.totalChunks > 1 ? '<div class="progress-wrap"><div class="progress-bar" style="width:0%"></div></div>' : ''}
    </div>
    <div class="file-actions">
      <span class="badge ${data.direction === 'sending' ? 'badge-sending' : 'badge-receiving'}">
        ${data.direction === 'sending' ? 'enviando' : 'recibiendo'}
      </span>
    </div>
  `
  dom.fileList.prepend(li)
  return li
}

function markDone(
  state: AppState,
  dom: TransferDom,
  itemEl: HTMLLIElement,
  download: { url: string; name: string; fileId: string } | null,
  expiry: ExpiryConfig | null
): void {
  const fileId = itemEl.dataset.fileId
  if (!fileId) return
  // If React UI is active, avoid direct DOM updates; React will render final state from maps
  if (state.uiReact) {
    if (download) {
      // ensure URL is set (should already be set by caller)
      state.fileUrls.set(download.fileId, download.url)
    }
    if (expiry?.time) startExpiryTimer(state, dom, fileId, expiry.time)
    if (expiry?.downloads) startDownloadLimit(state, dom, fileId, expiry.downloads)
    return
  }
  const actions = itemEl.querySelector<HTMLElement>('.file-actions')
  if (!actions) return
  let expiryBadge = ''
  if (expiry?.time)
    expiryBadge += `<span class="expiry-tag time" id="exp-tag-${fileId}">${expiry.time}s</span>`
  if (expiry?.downloads)
    expiryBadge += `<span class="expiry-tag dl" id="exp-dl-${fileId}">${expiry.downloads}</span>`

  if (download) {
    actions.innerHTML = `
      ${expiryBadge}
      <a class="btn-download" id="dl-btn-${fileId}" href="${download.url}" download="${escapeHtml(download.name)}">Descargar</a>
      <button class="btn-delete" title="Eliminar" data-delete-file="${fileId}">Eliminar</button>`
  } else {
    actions.innerHTML = `
      ${expiryBadge}
      <span class="badge badge-done">enviado</span>
      <button class="btn-delete" title="Eliminar" data-delete-file="${fileId}">Eliminar</button>`
  }
  actions.querySelector<HTMLButtonElement>('[data-delete-file]')?.addEventListener('click', () => {
    deleteFileItem(state, dom, fileId, true)
  })
  const bar = itemEl.querySelector<HTMLElement>('.progress-bar')
  if (bar) bar.style.width = '100%'
}

function updateProgress(itemEl: HTMLElement, received: number, total: number): void {
  const bar = itemEl.querySelector<HTMLElement>('.progress-bar')
  if (bar) bar.style.width = `${Math.round((received / total) * 100)}%`
}

function startExpiryTimer(
  state: AppState,
  dom: TransferDom,
  fileId: string,
  seconds: number
): void {
  let remaining = seconds
  const timer = window.setInterval(() => {
    remaining--
    const entry = state.fileExpiry.get(fileId) ?? {}
    entry.remaining = remaining
    state.fileExpiry.set(fileId, entry)
    if (remaining <= 0) {
      window.clearInterval(timer)
      state.fileExpiry.delete(fileId)
      deleteFileItem(state, dom, fileId, true)
    }
  }, 1000)
  state.fileExpiry.set(fileId, { ...state.fileExpiry.get(fileId), timer, remaining })
}

function startDownloadLimit(
  state: AppState,
  dom: TransferDom,
  fileId: string,
  maxDownloads: number
): void {
  let remaining = maxDownloads
  // For legacy DOM UI, attach click listener to the download button when present
  window.setTimeout(() => {
    const btn = document.getElementById(`dl-btn-${fileId}`)
    if (btn && !state.uiReact) {
      btn.addEventListener('click', () => {
        remaining--
        const tag = document.getElementById(`exp-dl-${fileId}`)
        if (tag) tag.textContent = `${remaining}`
        if (remaining <= 0) window.setTimeout(() => deleteFileItem(state, dom, fileId, true), 300)
      })
    }
  })
  state.fileExpiry.set(fileId, { ...state.fileExpiry.get(fileId), downloadsLeft: remaining })
}

export function recordDownload(state: AppState, dom: TransferDom, fileId: string): void {
  const entry = state.fileExpiry.get(fileId)
  if (!entry) return
  entry.downloadsLeft = (entry.downloadsLeft ?? 1) - 1
  state.fileExpiry.set(fileId, entry)
  if (entry.downloadsLeft <= 0) {
    window.setTimeout(() => deleteFileItem(state, dom, fileId, true), 300)
  }
}

function fileIcon(name: string): string {
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
    exe: 'app'
  }
  const kind = ext ? (icons[ext] ?? 'file') : 'file'
  // Return small inline SVGs for common kinds
  const svgs: Record<string, string> = {
    file: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    doc: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2v6a2 2 0 0 0 2 2h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="2" y="8" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/></svg>`,
    img: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M8 14l2.5-3 3.5 4.5 2.5-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    zip: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M8 7h8M10 11h4M10 15h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    mov: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M20 8v8l4-4-4-4z" fill="currentColor"/></svg>`,
    aud: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 12a4 4 0 0 0 4 4h1v2a2 2 0 0 0 4 0v-2h1a4 4 0 0 0 0-8h-1V6a2 2 0 0 0-4 0v2H8a4 4 0 0 0-4 4z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    code: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 18l6-6-6-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 6L2 12l6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    txt: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 7h10M4 11h12M4 15h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    md: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 3v18" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 6v12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 6v12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    app: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" stroke-width="1.4"/><path d="M8 12h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
  }
  return `<span class="icon-svg">${svgs[kind] ?? svgs.file}</span>`
}
