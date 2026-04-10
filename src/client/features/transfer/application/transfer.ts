import type { AppState } from '../../../app/state.js';
import type { ExpiryConfig, FileStartMessage, TransferMessage } from '../../../shared/domain/types.js';
import { escapeHtml, formatBytes } from '../../../shared/application/format.js';
import { relaySend, sendMeta } from '../../connection/application/webrtc.js';

const CHUNK_SIZE = 16 * 1024;

export interface TransferDom {
  fileListSection: HTMLElement;
  fileList: HTMLUListElement;
  expTimeOn: HTMLInputElement;
  expTimeVal: HTMLInputElement;
  expDlOn: HTMLInputElement;
  expDlVal: HTMLInputElement;
}

export async function sendFiles(state: AppState, dom: TransferDom, files: File[]): Promise<void> {
  for (const file of files) {
    await sendFile(state, dom, file);
  }
}

export function handleMetaMessage(state: AppState, dom: TransferDom, msg: TransferMessage): void {
  if (msg.type === 'file-start') {
    const itemEl = addFileItem(dom, {
      id: msg.fileId,
      name: msg.name,
      size: msg.size,
      direction: 'receiving',
      totalChunks: msg.totalChunks,
    });
    state.incoming.set(msg.fileId, { meta: msg, chunks: [], received: 0, itemEl });
    return;
  }

  if (msg.type === 'file-end') {
    const entry = state.incoming.get(msg.fileId);
    if (!entry) return;
    const blob = new Blob(entry.chunks, { type: entry.meta.mimeType });
    const url = URL.createObjectURL(blob);
    state.fileUrls.set(msg.fileId, url);
    const expiry = entry.meta.expiry ?? null;
    markDone(state, dom, entry.itemEl, { url, name: entry.meta.name, fileId: msg.fileId }, expiry);
    if (expiry?.time) startExpiryTimer(state, dom, msg.fileId, expiry.time);
    if (expiry?.downloads) startDownloadLimit(state, dom, msg.fileId, expiry.downloads);
    state.incoming.delete(msg.fileId);
    return;
  }

  if (msg.type === 'file-deleted') {
    deleteFileItem(state, dom, msg.fileId, false);
  }
}

export function handleChunk(state: AppState, buffer: ArrayBuffer): void {
  for (const [, entry] of state.incoming) {
    if (entry.received < entry.meta.totalChunks) {
      entry.chunks.push(buffer);
      entry.received++;
      updateProgress(entry.itemEl, entry.received, entry.meta.totalChunks);
      break;
    }
  }
}

export function deleteFileItem(
  state: AppState,
  dom: TransferDom,
  fileId: string,
  notifyPeer: boolean,
): void {
  const li = dom.fileList.querySelector<HTMLLIElement>(`[data-file-id="${fileId}"]`);
  li?.remove();
  const url = state.fileUrls.get(fileId);
  if (url) URL.revokeObjectURL(url);
  state.fileUrls.delete(fileId);
  const expiry = state.fileExpiry.get(fileId);
  if (expiry?.timer) window.clearInterval(expiry.timer);
  state.fileExpiry.delete(fileId);
  if (dom.fileList.children.length === 0) dom.fileListSection.classList.add('hidden');
  if (notifyPeer) sendMeta(state, { type: 'file-deleted', fileId });
}

export function cleanupFiles(state: AppState, dom: TransferDom): void {
  state.fileUrls.forEach(url => URL.revokeObjectURL(url));
  state.fileUrls.clear();
  state.fileExpiry.forEach(entry => {
    if (entry.timer) window.clearInterval(entry.timer);
  });
  state.fileExpiry.clear();
  state.incoming.clear();
  dom.fileList.innerHTML = '';
  dom.fileListSection.classList.add('hidden');
}

async function sendFile(state: AppState, dom: TransferDom, file: File): Promise<void> {
  const fileId = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const itemEl = addFileItem(dom, {
    id: fileId,
    name: file.name,
    size: file.size,
    direction: 'sending',
    totalChunks,
  });
  const expiry = getExpiryConfig(dom);
  const meta: FileStartMessage = {
    type: 'file-start',
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
    ...(expiry ? { expiry } : {}),
  };
  const buffer = await file.arrayBuffer();

  if (state.useRelay) {
    relaySend(state, meta);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      relaySend(state, buffer.slice(start, start + CHUNK_SIZE));
      updateProgress(itemEl, i + 1, totalChunks);
      if (i % 20 === 19) await new Promise(requestAnimationFrame);
    }
    relaySend(state, { type: 'file-end', fileId });
  } else if (state.dc?.readyState === 'open') {
    state.dc.send(JSON.stringify(meta));
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      state.dc.send(buffer.slice(start, start + CHUNK_SIZE));
      updateProgress(itemEl, i + 1, totalChunks);
      if (state.dc.bufferedAmount > 1024 * 1024) await waitForBuffer(state);
    }
    state.dc.send(JSON.stringify({ type: 'file-end', fileId }));
  }

  markDone(state, dom, itemEl, null, expiry);
  if (expiry?.time) startExpiryTimer(state, dom, fileId, expiry.time);
}

function waitForBuffer(state: AppState): Promise<void> {
  return new Promise(resolve => {
    const check = window.setInterval(() => {
      if (!state.dc || state.dc.bufferedAmount < 256 * 1024) {
        window.clearInterval(check);
        resolve();
      }
    }, 50);
  });
}

function getExpiryConfig(dom: TransferDom): ExpiryConfig | null {
  const cfg: ExpiryConfig = {};
  if (dom.expTimeOn.checked) cfg.time = Math.max(1, Number.parseInt(dom.expTimeVal.value, 10) || 30);
  if (dom.expDlOn.checked) cfg.downloads = Math.max(1, Number.parseInt(dom.expDlVal.value, 10) || 1);
  return cfg.time || cfg.downloads ? cfg : null;
}

function addFileItem(
  dom: TransferDom,
  data: { id: string; name: string; size: number; direction: 'sending' | 'receiving'; totalChunks: number },
): HTMLLIElement {
  dom.fileListSection.classList.remove('hidden');
  const li = document.createElement('li');
  li.className = 'file-item';
  li.dataset.fileId = data.id;
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
  `;
  dom.fileList.prepend(li);
  return li;
}

function markDone(
  state: AppState,
  dom: TransferDom,
  itemEl: HTMLLIElement,
  download: { url: string; name: string; fileId: string } | null,
  expiry: ExpiryConfig | null,
): void {
  const fileId = itemEl.dataset.fileId;
  if (!fileId) return;
  const actions = itemEl.querySelector<HTMLElement>('.file-actions');
  if (!actions) return;
  let expiryBadge = '';
  if (expiry?.time) expiryBadge += `<span class="expiry-tag time" id="exp-tag-${fileId}">${expiry.time}s</span>`;
  if (expiry?.downloads) expiryBadge += `<span class="expiry-tag dl" id="exp-dl-${fileId}">${expiry.downloads}</span>`;

  if (download) {
    actions.innerHTML = `
      ${expiryBadge}
      <a class="btn-download" id="dl-btn-${fileId}" href="${download.url}" download="${escapeHtml(download.name)}">Descargar</a>
      <button class="btn-delete" title="Eliminar" data-delete-file="${fileId}">Eliminar</button>`;
  } else {
    actions.innerHTML = `
      ${expiryBadge}
      <span class="badge badge-done">enviado</span>
      <button class="btn-delete" title="Eliminar" data-delete-file="${fileId}">Eliminar</button>`;
  }
  actions.querySelector<HTMLButtonElement>('[data-delete-file]')?.addEventListener('click', () => {
    deleteFileItem(state, dom, fileId, true);
  });
  const bar = itemEl.querySelector<HTMLElement>('.progress-bar');
  if (bar) bar.style.width = '100%';
}

function updateProgress(itemEl: HTMLElement, received: number, total: number): void {
  const bar = itemEl.querySelector<HTMLElement>('.progress-bar');
  if (bar) bar.style.width = `${Math.round((received / total) * 100)}%`;
}

function startExpiryTimer(state: AppState, dom: TransferDom, fileId: string, seconds: number): void {
  let remaining = seconds;
  const timer = window.setInterval(() => {
    remaining--;
    const tag = document.getElementById(`exp-tag-${fileId}`);
    if (tag) {
      tag.textContent = `${remaining}s`;
      if (remaining <= 5) tag.classList.add('urgent');
    }
    if (remaining <= 0) {
      window.clearInterval(timer);
      state.fileExpiry.delete(fileId);
      deleteFileItem(state, dom, fileId, true);
    }
  }, 1000);
  state.fileExpiry.set(fileId, { ...state.fileExpiry.get(fileId), timer });
}

function startDownloadLimit(state: AppState, dom: TransferDom, fileId: string, maxDownloads: number): void {
  let remaining = maxDownloads;
  window.setTimeout(() => {
    document.getElementById(`dl-btn-${fileId}`)?.addEventListener('click', () => {
      remaining--;
      const tag = document.getElementById(`exp-dl-${fileId}`);
      if (tag) tag.textContent = `${remaining}`;
      if (remaining <= 0) window.setTimeout(() => deleteFileItem(state, dom, fileId, true), 300);
    });
  });
  state.fileExpiry.set(fileId, { ...state.fileExpiry.get(fileId), downloadsLeft: remaining });
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const icons: Record<string, string> = {
    pdf: 'doc', zip: 'zip', tar: 'zip', gz: 'zip', rar: 'zip',
    jpg: 'img', jpeg: 'img', png: 'img', gif: 'img', webp: 'img', svg: 'img',
    mp4: 'mov', mkv: 'mov', mov: 'mov', avi: 'mov',
    mp3: 'aud', wav: 'aud', flac: 'aud',
    js: 'code', ts: 'code', json: 'code', html: 'code', css: 'code',
    txt: 'txt', md: 'md',
    dmg: 'app', exe: 'app',
  };
  return ext ? icons[ext] ?? 'file' : 'file';
}
