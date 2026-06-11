import * as blessed from 'blessed'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { Store } from '../store'
import type { Theme } from './themes'
import { THEMES } from './themes'
import type { TextMessage } from '../types'
import {
  showTextInput, showFileBrowser, showDownloadConfirm,
  showSendOptions, showThemeSelector, showToast,
} from './dialogs'

export interface ActionContext {
  screen: blessed.Widgets.Screen
  store: Store
  flags: {
    dialogOpen: boolean
    downloadDialogShowing: boolean
    isSending: boolean
  }
  applyTheme(t: Theme): void
}

export function doCreateRoom(ctx: ActionContext): void {
  if (ctx.store.get().screen === 'room') return
  ctx.store.createRoom().catch((e: Error) => showToast(ctx.screen, e.message, 'error'))
}

export async function doJoinRoom(ctx: ActionContext): Promise<void> {
  if (ctx.store.get().screen === 'room') return
  ctx.flags.dialogOpen = true
  const code = await showTextInput(ctx.screen, {
    title: 'Unirse a sala',
    prompt: 'Código de sala (4 caracteres):',
    hint: '{gray-fg}Enter confirmar  Esc cancelar{/gray-fg}',
  })
  ctx.flags.dialogOpen = false
  if (code) {
    ctx.store.joinRoom(code).catch((e: Error) => showToast(ctx.screen, e.message, 'error'))
  }
}

export async function doSendFile(ctx: ActionContext): Promise<void> {
  const st = ctx.store.get()
  if (st.connectionStatus !== 'relay' && st.connectionStatus !== 'connected') {
    showToast(ctx.screen, 'Necesitas estar conectado a un peer primero.', 'warning')
    return
  }
  if (ctx.flags.isSending) return

  ctx.flags.dialogOpen = true

  const choice = await showTextInput(ctx.screen, {
    title: 'Enviar archivo',
    prompt: `Ruta del archivo  {gray-fg}(Enter para explorar){/gray-fg}:`,
    hint: '{gray-fg}Escribe ruta o deja vacío y presiona Enter para explorar{/gray-fg}',
    width: 68,
  })

  if (choice === null) { ctx.flags.dialogOpen = false; return }

  let filePath: string | null = null
  if (choice === '') {
    filePath = await showFileBrowser(ctx.screen)
  } else {
    filePath = choice.replace(/^~/, os.homedir())
  }

  if (!filePath) { ctx.flags.dialogOpen = false; return }

  const name = path.basename(filePath)
  let size = 0
  try { size = fs.statSync(filePath).size } catch {}

  const sendOpts = await showSendOptions(ctx.screen, name, size)
  ctx.flags.dialogOpen = false

  if (sendOpts === false) return

  ctx.flags.isSending = true
  ctx.store.sendFile(filePath, sendOpts ?? undefined)
    .catch((e: Error) => showToast(ctx.screen, e.message, 'error'))
    .finally(() => { ctx.flags.isSending = false })
}

function detectFormat(content: string): TextMessage['format'] {
  const trimmed = content.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return 'json' } catch { /* not json */ }
  }
  if (trimmed.startsWith('---') || /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*\S/m.test(trimmed)) return 'yaml'
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return 'html'
  if (/^#\s|^##\s|^\*\*|^[-*]\s|^>\s|```|\[.+\]\(.+\)/m.test(trimmed)) return 'markdown'
  return 'plain'
}

export async function doSendText(ctx: ActionContext): Promise<void> {
  const st = ctx.store.get()
  if (st.connectionStatus !== 'relay' && st.connectionStatus !== 'connected') {
    showToast(ctx.screen, 'Necesitas estar conectado a un peer primero.', 'warning')
    return
  }

  ctx.flags.dialogOpen = true
  const content = await showTextInput(ctx.screen, {
    title: 'Enviar mensaje',
    prompt: 'Escribe tu mensaje:',
    hint: '{gray-fg}Enter enviar  Esc cancelar{/gray-fg}',
    width: 68,
  })
  ctx.flags.dialogOpen = false

  if (content === null || content === '') return

  const format = detectFormat(content)
  ctx.store.sendText(content, format)
}

export async function doThemeSelector(ctx: ActionContext): Promise<void> {
  ctx.flags.dialogOpen = true
  const newTheme = await showThemeSelector(ctx.screen, ctx.store.get().theme)
  ctx.flags.dialogOpen = false
  if (newTheme && newTheme !== ctx.store.get().theme) {
    ctx.store.setTheme(newTheme as 'dark' | 'light')
    ctx.applyTheme(THEMES[newTheme])
  }
}

export async function checkPendingDownloads(ctx: ActionContext): Promise<void> {
  if (ctx.flags.downloadDialogShowing || ctx.flags.dialogOpen) return
  const pending = ctx.store.get().pendingDownloads
  if (pending.length === 0) return

  ctx.flags.downloadDialogShowing = true
  ctx.flags.dialogOpen = true
  const d = pending[0]
  const accept = await showDownloadConfirm(ctx.screen, d.name, d.size)
  ctx.flags.dialogOpen = false
  ctx.flags.downloadDialogShowing = false

  if (accept) ctx.store.acceptDownload(d.fileId)
  else ctx.store.rejectDownload(d.fileId)
}
