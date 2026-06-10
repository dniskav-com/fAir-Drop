import type { AppState } from '@client/app/state'
import type { TextMessage, TextDeletedMessage } from '@shared/domain/types'
import { sendMeta } from '@features/connection/application/webrtc'
import { generateId } from '@shared/application/format'

export function sendText(
  state: AppState,
  content: string,
  format: string,
  notify: () => void,
): void {
  const msg: TextMessage = {
    type: 'text-inline',
    id: generateId(),
    content,
    format: format as TextMessage['format'],
    timestamp: new Date().toISOString(),
  }
  sendMeta(state, msg)
  state.textMessages.set(msg.id, { message: msg, direction: 'sending' })
  notify()
}

export function handleTextMessage(
  state: AppState,
  msg: TextMessage,
  notify: () => void,
): void {
  state.textMessages.set(msg.id, { message: msg, direction: 'receiving' })
  notify()
}

export function deleteText(
  state: AppState,
  id: string,
  notify: () => void,
): void {
  state.textMessages.delete(id)
  const expiry = state.textExpiry.get(id)
  if (expiry?.timer) window.clearTimeout(expiry.timer)
  state.textExpiry.delete(id)
  const del: TextDeletedMessage = { type: 'text-deleted', id }
  sendMeta(state, del)
  notify()
}

export function copyText(state: AppState, id: string): string | null {
  const entry = state.textMessages.get(id)
  return entry?.message.content ?? null
}
