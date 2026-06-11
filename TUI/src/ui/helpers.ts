import type { ConnectionStatus, ConnectionType, LogEntry } from '../types'
import type { Theme } from './themes'

export function tag(color: string, text: string): string {
  return `{${color}-fg}${text}{/${color}-fg}`
}

export function bold(s: string): string {
  return `{bold}${s}{/bold}`
}

export function statusLabel(s: ConnectionStatus): string {
  const labels: Record<ConnectionStatus, string> = {
    disconnected: 'Desconectado',
    connecting: 'Conectando…',
    waiting: 'Esperando peer',
    relay: 'Relay activo',
    connected: 'Conectado P2P',
  }
  return labels[s] ?? s
}

export function statusColor(s: ConnectionStatus, t: Theme): string {
  const colors: Record<ConnectionStatus, string> = {
    connected: t.success,
    relay: t.warning,
    waiting: t.accent,
    connecting: t.accent,
    disconnected: t.dim,
  }
  return colors[s] ?? t.dim
}

export function connTypeLabel(ct: ConnectionType, t: Theme): string {
  if (ct === 'relay') return tag(t.warning, 'Relay (WS)')
  if (ct === 'p2p')   return tag(t.success, 'P2P directo')
  return tag(t.dim, 'Detectando…')
}

export function progressBar(pct: number, width: number, color: string): string {
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return tag(color, '█'.repeat(n)) + tag('gray', '░'.repeat(width - n)) + ' ' + tag(color, `${pct}%`)
}

export function logColor(type: LogEntry['type'], t: Theme): string {
  const map: Record<LogEntry['type'], string> = {
    success: t.success,
    error: t.error,
    warning: t.warning,
    info: t.dim,
  }
  return map[type] ?? t.dim
}

export function elapsedStr(startMs: number): string {
  const s = Math.round((Date.now() - startMs) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}
