import type { AppState } from '@client/app/state'
import type { ExpiryRuntime } from '@client/app/state'
import type { TextMessage, TextDeletedMessage, ExpiryConfig } from '@shared/domain/types'
import { sendMeta } from '@features/connection/application/webrtc'
import { generateId } from '@shared/application/format'

export function sendText(
  state: AppState,
  content: string,
  format: string,
  expiry: ExpiryConfig | null,
  notify: () => void,
): void {
  const msg: TextMessage = {
    type: 'text-inline',
    id: generateId(),
    content,
    format: format as TextMessage['format'],
    timestamp: new Date().toISOString(),
    ...(expiry ? { expiry } : {}),
  }
  sendMeta(state, msg)
  state.textMessages.set(msg.id, { message: msg, direction: 'sending' })
  if (expiry?.time) startExpiryTimer(state, msg.id, expiry.time, notify)
  if (expiry?.downloads) startCopyLimit(state, msg.id, expiry.downloads)
  notify()
}

export function handleTextMessage(
  state: AppState,
  msg: TextMessage,
  notify: () => void,
): void {
  state.textMessages.set(msg.id, { message: msg, direction: 'receiving' })
  if (msg.expiry?.time) startExpiryTimer(state, msg.id, msg.expiry.time, notify)
  if (msg.expiry?.downloads) startCopyLimit(state, msg.id, msg.expiry.downloads)
  notify()
}

export function deleteText(
  state: AppState,
  id: string,
  notify: () => void,
): void {
  state.textMessages.delete(id)
  const expiry = state.textExpiry.get(id)
  if (expiry?.timer) window.clearInterval(expiry.timer)
  state.textExpiry.delete(id)
  const del: TextDeletedMessage = { type: 'text-deleted', id }
  sendMeta(state, del)
  notify()
}

export function copyText(state: AppState, id: string): string | null {
  const entry = state.textMessages.get(id)
  return entry?.message.content ?? null
}

export function recordCopy(state: AppState, id: string, notify: () => void): void {
  const entry = state.textExpiry.get(id)
  if (!entry) return
  entry.downloadsLeft = (entry.downloadsLeft ?? 1) - 1
  state.textExpiry.set(id, { ...entry })
  if ((entry.downloadsLeft ?? 0) <= 0) {
    window.setTimeout(() => deleteText(state, id, notify), 300)
  }
  notify()
}

// ── Internos ─────────────────────────────────────────────────────────────────

function startExpiryTimer(
  state: AppState,
  id: string,
  seconds: number,
  notify: () => void,
): void {
  let remaining = seconds
  const runtime: ExpiryRuntime = { remaining, ...state.textExpiry.get(id) }
  const timer = window.setInterval(() => {
    remaining--
    const entry = state.textExpiry.get(id)
    if (entry) {
      entry.remaining = remaining
      state.textExpiry.set(id, { ...entry })
    }
    notify()
    if (remaining <= 0) {
      window.clearInterval(timer)
      deleteText(state, id, notify)
    }
  }, 1000)
  state.textExpiry.set(id, { ...runtime, timer })
}

function startCopyLimit(state: AppState, id: string, maxDownloads: number): void {
  state.textExpiry.set(id, {
    ...state.textExpiry.get(id),
    downloadsLeft: maxDownloads,
  })
}
