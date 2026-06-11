import * as blessed from 'blessed'
import type { Store } from '../store'
import { THEMES, type Theme } from './themes'
import { buildLayout, applyFocus, applyThemeToLayout, type PanelSet } from './layout'
import {
  doCreateRoom, doJoinRoom, doSendFile, doThemeSelector, doSendText,
  checkPendingDownloads, type ActionContext,
} from './actions'
import {
  renderHeader, renderFooter, renderQR,
  renderActions, renderRoom, renderTransfers,
  renderPeers, renderActivity,
  type ActionItem, type QRCache,
} from './render'

// ── Action menu definition ────────────────────────────────────────────────────

const ACTION_ITEMS: ActionItem[] = [
  { key: 'create', icon: '◈', shortcut: '1',   label: 'Crear sala',     requiresRoom: false, requiresNoRoom: true  },
  { key: 'join',   icon: '→', shortcut: '2',   label: 'Unirse a sala',  requiresRoom: false, requiresNoRoom: true  },
  { key: 'send',   icon: '↑', shortcut: 's',   label: 'Enviar archivo', requiresRoom: true,  requiresNoRoom: false },
  { key: 'text',   icon: '✎', shortcut: 'm',   label: 'Enviar mensaje', requiresRoom: true,  requiresNoRoom: false },
  { key: 'theme',  icon: '◉', shortcut: 't',   label: 'Cambiar tema',   requiresRoom: false, requiresNoRoom: false },
  { key: 'leave',  icon: '←', shortcut: 'Esc', label: 'Salir de sala',  requiresRoom: true,  requiresNoRoom: false },
  { key: 'quit',   icon: '×', shortcut: 'q',   label: 'Salir',          requiresRoom: false, requiresNoRoom: false },
]

// ── App ───────────────────────────────────────────────────────────────────────

export class App {
  private readonly screen: blessed.Widgets.Screen
  private theme: Theme
  private focusedIdx = 0
  private selectedAction = 0
  private qrCache: QRCache = { url: null, content: null }
  private layout!: PanelSet
  private ctx!: ActionContext
  private readonly unsub: () => void

  constructor(private readonly store: Store) {
    this.theme = THEMES[store.get().theme] ?? THEMES['dark']
    this.screen = blessed.screen({
      smartCSR: true, title: 'fAir Drop TUI',
      fullUnicode: true, dockBorders: false,
      mouse: true, forceUnicode: true,
    })
    this.layout = buildLayout(this.screen, this.theme)
    applyFocus(this.layout, 0, this.theme)
    this.ctx = this.buildContext()
    this.bindKeys()
    this.unsub = store.subscribe(() => this.onStoreUpdate())
    this.render()
  }

  // ── Context for action handlers ──────────────────────────────────────────────

  private buildContext(): ActionContext {
    const flags = { dialogOpen: false, downloadDialogShowing: false, isSending: false }
    return {
      screen: this.screen,
      store: this.store,
      flags,
      applyTheme: (t: Theme) => this.applyTheme(t),
    }
  }

  // ── Key bindings ─────────────────────────────────────────────────────────────

  private bindKeys(): void {
    const s = this.screen
    const f = this.ctx.flags

    s.key(['tab'], () => {
      if (f.dialogOpen) return
      this.focusedIdx = (this.focusedIdx + 1) % this.layout.panels.length
      applyFocus(this.layout, this.focusedIdx, this.theme)
      this.render()
    })

    s.key(['up'], () => {
      if (f.dialogOpen || this.focusedIdx !== 0) return
      this.selectedAction = Math.max(0, this.selectedAction - 1)
      renderActions(this.layout.actionsBox, this.store.get(), this.theme, ACTION_ITEMS, this.selectedAction, true)
      this.screen.render()
    })

    s.key(['down'], () => {
      if (f.dialogOpen || this.focusedIdx !== 0) return
      this.selectedAction = Math.min(ACTION_ITEMS.length - 1, this.selectedAction + 1)
      renderActions(this.layout.actionsBox, this.store.get(), this.theme, ACTION_ITEMS, this.selectedAction, true)
      this.screen.render()
    })

    s.key(['enter'], () => {
      if (f.dialogOpen) return
      if (this.focusedIdx === 0) this.executeAction(ACTION_ITEMS[this.selectedAction].key)
    })

    s.key(['q', 'Q'], () => {
      if (f.dialogOpen) return
      if (this.store.get().screen === 'room') {
        this.store.leaveRoom()
        setTimeout(() => process.exit(0), 400)
      } else {
        process.exit(0)
      }
    })

    s.key(['C-c'], () => process.exit(0))

    s.key(['escape'], () => {
      if (f.dialogOpen) return
      if (this.store.get().screen === 'room') this.store.leaveRoom()
    })

    s.key(['1'], () => { if (!f.dialogOpen) doCreateRoom(this.ctx) })
    s.key(['2'], () => { if (!f.dialogOpen) doJoinRoom(this.ctx) })
    s.key(['s', 'S'], () => { if (!f.dialogOpen) doSendFile(this.ctx) })
    s.key(['m', 'M'], () => { if (!f.dialogOpen) doSendText(this.ctx) })
    s.key(['t', 'T'], () => { if (!f.dialogOpen) doThemeSelector(this.ctx) })
  }

  private executeAction(key: string): void {
    switch (key) {
      case 'create': doCreateRoom(this.ctx); break
      case 'join':   doJoinRoom(this.ctx);   break
      case 'send':   doSendFile(this.ctx);   break
      case 'text':   doSendText(this.ctx);   break
      case 'theme':  doThemeSelector(this.ctx); break
      case 'leave':
        if (this.store.get().screen === 'room') this.store.leaveRoom()
        break
      case 'quit': process.exit(0)
    }
  }

  // ── Theme ────────────────────────────────────────────────────────────────────

  private applyTheme(t: Theme): void {
    this.theme = t
    applyThemeToLayout(this.layout, t)
    applyFocus(this.layout, this.focusedIdx, t)
    this.render()
  }

  // ── Store update & render ────────────────────────────────────────────────────

  private onStoreUpdate(): void {
    const state = this.store.get()
    this.theme = THEMES[state.theme] ?? THEMES['dark']
    this.render()
    if (state.pendingDownloads.length > 0) {
      setImmediate(() => checkPendingDownloads(this.ctx))
    }
  }

  private render(): void {
    const state = this.store.get()
    const t = this.theme
    const l = this.layout
    renderHeader(l.header, state, t)
    renderActions(l.actionsBox, state, t, ACTION_ITEMS, this.selectedAction, this.focusedIdx === 0)
    renderQR(l.qrBox, state, t, this.qrCache)
    renderRoom(l.roomBox, state, t)
    renderTransfers(l.transfersBox, state, t)
    renderPeers(l.peersBox, state, t, this.focusedIdx === 3)
    renderActivity(l.activityBox, state, t)
    renderFooter(l.footer, state, t)
    this.screen.render()
  }

  destroy(): void {
    this.unsub()
    try { this.screen.destroy() } catch {}
  }
}
