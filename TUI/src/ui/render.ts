import * as blessed from 'blessed'
import * as QRCode from 'qrcode'
import { formatBytes } from '../utils'
import { tag, bold, statusLabel, statusColor, connTypeLabel, progressBar, logColor, elapsedStr } from './helpers'
import type { AppState } from '../types'
import type { Theme } from './themes'

// ── QR cache ──────────────────────────────────────────────────────────────────

export interface QRCache {
  url: string | null
  content: string | null
}

export function buildQRContent(url: string): string {
  const qrData = (QRCode as any).create(url, { errorCorrectionLevel: 'L' })
  const { size, data } = qrData.modules as { size: number; data: Uint8Array }
  const margin = 1

  const isDark = (r: number, c: number): boolean => {
    if (r < 0 || r >= size || c < 0 || c >= size) return false
    return data[r * size + c] > 0
  }

  const cell = (top: boolean, bot: boolean): string => {
    if (!top && !bot) return '{white-bg} '
    if (top  && bot)  return '{black-bg} '
    if (!top && bot)  return '{white-bg}{black-fg}▄{/black-fg}'
    return '{white-bg}{black-fg}▀{/black-fg}'
  }

  const lines: string[] = []
  for (let row = -margin; row < size + margin; row += 2) {
    let line = ''
    for (let col = -margin; col < size + margin; col++) {
      line += cell(isDark(row, col), isDark(row + 1, col))
    }
    lines.push(line + '{/}')
  }
  return lines.join('\n')
}

// ── Panel renderers ───────────────────────────────────────────────────────────

export function renderHeader(
  header: blessed.Widgets.BoxElement,
  state: AppState,
  t: Theme
): void {
  const col = statusColor(state.connectionStatus, t)
  const server = state.serverUrl.replace(/^wss?:\/\//, '').replace('/ws', '')
  const connType = state.connectionType !== 'unknown'
    ? `  ${tag(t.dim, '⊙')} ${connTypeLabel(state.connectionType, t)}` : ''
  const ip = state.selfInfo ? `  ${tag(t.dim, 'IP:')} ${tag(t.dim, state.selfInfo.ip)}` : ''
  header.setContent(
    `  ${bold(tag('white', 'f') + tag(t.accent, 'Air Drop'))}  {gray-fg}v1.0.0   ${server}{/gray-fg}   ${tag(col, '●')} ${tag(col, statusLabel(state.connectionStatus))}${connType}${ip}`
  )
}

export function renderFooter(
  footer: blessed.Widgets.BoxElement,
  _state: AppState,
  t: Theme
): void {
  const d = t.dim
  const k = (key: string, desc: string): string => `${tag('white', key)} ${tag(d, desc)}`
  const shortcuts = [
    k('Tab', 'panel'), k('↑/↓', 'navegar'), k('Enter', 'seleccionar'),
    k('s', 'enviar'), k('m', 'mensaje'), k('t', 'tema'), k('Esc', 'sala'), k('q', 'salir'),
  ].join(`  ${tag(d, '│')}  `)
  footer.setContent(`  ${tag(d, '((·))')}  ${shortcuts}`)
}

export function renderQR(
  qrBox: blessed.Widgets.BoxElement,
  state: AppState,
  t: Theme,
  cache: QRCache
): void {
  if (state.screen !== 'room' || !state.roomCode) {
    qrBox.setLabel(` {${t.accent}-fg}QR{/${t.accent}-fg} `)
    qrBox.setContent(`\n  ${tag(t.dim, 'Sin sala activa')}`)
    return
  }

  const serverHost = state.serverUrl.replace(/^wss?:\/\//, '').replace('/ws', '')
  const proto = state.serverUrl.startsWith('wss') ? 'https' : 'http'
  const url = `${proto}://${serverHost}/?room=${state.roomCode}`
  qrBox.setLabel(` {${t.accent}-fg}QR — ${state.roomCode}{/${t.accent}-fg} `)

  if (cache.url !== url) {
    cache.url = url
    try { cache.content = buildQRContent(url) } catch { cache.content = null }
  }

  qrBox.setContent(cache.content ?? `\n  ${tag(t.dim, 'Error generando QR')}`)
}

export interface ActionItem {
  key: string
  icon: string
  shortcut: string
  label: string
  requiresRoom: boolean
  requiresNoRoom: boolean
}

export function renderActions(
  actionsBox: blessed.Widgets.BoxElement,
  state: AppState,
  t: Theme,
  items: ActionItem[],
  selectedIdx: number,
  isPanelFocused: boolean
): void {
  const inRoom = state.screen === 'room'
  const lines = items.map((item, i) => {
    const isSelected = i === selectedIdx && isPanelFocused
    const dimmed = (item.requiresRoom && !inRoom) || (item.requiresNoRoom && inRoom)
    const labelColor = dimmed ? t.dim : t.fg
    const numColor = dimmed ? t.dim : t.accent
    if (isSelected) {
      return `  {blue-bg} ${tag(t.accent, item.icon)} ${tag('cyan', item.shortcut)}  ${tag('white', item.label)} {/blue-bg}`
    }
    return `  ${tag(t.accent, item.icon)} ${tag(numColor, item.shortcut)}  ${tag(labelColor, item.label)}`
  })
  actionsBox.setContent('\n' + lines.join('\n'))
}

export function renderRoom(
  roomBox: blessed.Widgets.BoxElement,
  state: AppState,
  t: Theme
): void {
  if (state.screen === 'home' || !state.roomCode) {
    const err = state.homeError ? `\n\n  ${tag(t.error, '✗ ' + state.homeError)}` : ''
    roomBox.setContent(
      `\n  ${tag(t.dim, 'Sin sala activa.')}\n\n  Pulsa ${tag('white', '1')} para crear o ${tag('white', '2')} para unirte.${err}`
    )
    return
  }

  const role = state.isCreator
    ? `{${t.accent}-bg}{black-fg} ANFITRIÓN {/black-fg}{/${t.accent}-bg}`
    : `{blue-bg}{white-fg} INVITADO {/white-fg}{/blue-bg}`

  const dot = state.connectionStatus === 'waiting' ? tag(t.accent, '◔') : tag(t.success, '●')
  const serverHost = state.serverUrl.replace(/^wss?:\/\//, '').replace('/ws', '')
  const proto = state.serverUrl.startsWith('wss') ? 'https' : 'http'
  const shareUrl = `${proto}://${serverHost}/?room=${state.roomCode}`
  const shortUrl = shareUrl.replace(/^https?:\/\//, '')

  const waitMsg = state.connectionStatus === 'waiting'
    ? tag(t.dim, 'Esperando que alguien se una…')
    : tag(t.dim, "Pulsa 's' para enviar archivos")

  const lines = [
    '',
    `  ${dot} Sala: ${bold(tag('white', state.roomCode))}  ${role}  Peers: ${state.peerInfo ? '1/2' : '0/1'}`,
    `  ${tag(t.dim, '☑')} ${tag(t.accent, shortUrl)}`,
    `  ${tag(t.dim, '⊙')} ${connTypeLabel(state.connectionType, t)}`,
    '',
    `  ${waitMsg}`,
  ]
  if (state.roomError) lines.push(`  ${tag(t.error, '✗ ' + state.roomError)}`)

  roomBox.setContent(lines.join('\n'))
}

export function renderTransfers(
  transfersBox: blessed.Widgets.BoxElement,
  state: AppState,
  t: Theme
): void {
  const lines: string[] = ['']
  const active = [...state.transfers.values()]

  // Text messages (shown above file transfers)
  for (const [, entry] of state.textMessages) {
    const dir = entry.direction === 'sending' ? tag(t.success, '→') : tag(t.warning, '←')
    const preview = entry.message.content.slice(0, 40).replace(/\n/g, ' ')
    const ellipsis = entry.message.content.length > 40 ? '…' : ''
    lines.push(`  ${dir} [${entry.message.format}] ${preview}${ellipsis}`)
  }

  if (state.textMessages.size > 0 && active.length > 0) {
    lines.push(`  ${tag(t.dim, '─'.repeat(36))}`)
  }

  for (const tr of active) {
    const pct = tr.totalChunks > 0 ? Math.round((tr.received / tr.totalChunks) * 100) : 0
    const dir = tr.direction === 'sending' ? tag(t.success, '↑') : tag(t.warning, '↓')
    const color = tr.direction === 'sending' ? t.success : t.warning
    const statusTxt = tr.direction === 'sending' ? tag(t.success, 'Enviando') : tag(t.warning, 'Recibiendo')
    lines.push(`  ${dir} ${bold(tr.name)}`)
    lines.push(`    ${progressBar(pct, 28, color)}`)
    lines.push(`    ${tag(t.dim, formatBytes(tr.size))} • ${statusTxt} • ${tag(t.dim, elapsedStr(tr.startTime))}`)
    lines.push('')
  }

  for (const pd of state.pendingDownloads) {
    lines.push(`  ${tag(t.warning, '↓')} ${bold(pd.name)}`)
    lines.push(`    ${progressBar(100, 28, t.warning)}`)
    lines.push(`    ${tag(t.dim, formatBytes(pd.size))} • ${tag(t.warning, '⬇ Confirmar descarga')}`)
    lines.push('')
  }

  const completed = state.completedTransfers.slice(0, 5)
  if (completed.length > 0) {
    if (active.length > 0) lines.push(`  ${tag(t.dim, '─'.repeat(36))}`)
    for (const tr of completed) {
      const dir = tr.direction === 'sending' ? tag(t.dim, '↑') : tag(t.dim, '↓')
      lines.push(`  ${dir} ${tag(t.dim, tr.name)} — ${tag(t.dim, formatBytes(tr.size))} — ${tag(t.success, '✓')}`)
      if (tr.savedPath) lines.push(`    ${tag(t.dim, '→ ' + tr.savedPath)}`)
    }
  }

  if (active.length === 0 && completed.length === 0 && state.pendingDownloads.length === 0) {
    lines.push(`  ${tag(t.dim, 'Sin transferencias activas.')}`)
  }

  lines.push('')
  lines.push(`  ${tag(t.dim, 'Comandos:')} ${tag('white', 's')} ${tag(t.dim, 'enviar')}   ${tag('white', 'r')} ${tag(t.dim, 'reintentar')}`)
  transfersBox.setContent(lines.join('\n'))
}

export function renderPeers(
  peersBox: blessed.Widgets.BoxElement,
  state: AppState,
  t: Theme,
  isPanelFocused: boolean
): void {
  const lines = ['']
  if (state.peerInfo) {
    const connTag = state.connectionType === 'relay' ? tag(t.warning, 'RELAY') : tag(t.success, 'P2P')
    const device = state.peerInfo.mobile ? '📱' : '🖥 '
    lines.push(`  ${tag(t.success, '●')} ${device} ${tag('white', state.peerInfo.browser)}`)
    lines.push(`    ${tag(t.dim, state.peerInfo.ip)}  ${connTag}`)
  } else {
    lines.push(`  ${tag(t.dim, state.screen === 'room' ? 'Esperando peer…' : 'Sin peers')}`)
  }
  const peerLabel = state.peerInfo ? tag(t.success, '1 conectado') : tag(t.dim, '0 conectados')
  const peersTitle = isPanelFocused
    ? `{${t.borderFocus}-fg}► PEERS{/${t.borderFocus}-fg}`
    : `{${t.accent}-fg}PEERS{/${t.accent}-fg}`
  peersBox.setLabel(` ${peersTitle}  ${peerLabel} `)
  peersBox.setContent(lines.join('\n'))
}

export function renderActivity(
  activityBox: blessed.Widgets.BoxElement,
  state: AppState,
  t: Theme
): void {
  const lines = state.log.slice(0, 40).map((e) => {
    const c = logColor(e.type, t)
    return ` ${tag(t.dim, '>')} ${tag(t.dim, '[' + e.time + ']')} ${tag(c, e.message)}`
  })
  activityBox.setContent(lines.join('\n'))
}
