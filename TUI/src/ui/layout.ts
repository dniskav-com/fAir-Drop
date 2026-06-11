import * as blessed from 'blessed'
import type { Theme } from './themes'

export interface PanelSet {
  header: blessed.Widgets.BoxElement
  actionsBox: blessed.Widgets.BoxElement
  qrBox: blessed.Widgets.BoxElement
  roomBox: blessed.Widgets.BoxElement
  transfersBox: blessed.Widgets.BoxElement
  peersBox: blessed.Widgets.BoxElement
  activityBox: blessed.Widgets.BoxElement
  footer: blessed.Widgets.BoxElement
  panels: blessed.Widgets.BoxElement[]
  panelLabels: string[]
}

export function buildLayout(screen: blessed.Widgets.Screen, t: Theme): PanelSet {
  const s = screen
  const dimBorder = { type: 'line' as const, fg: t.borderDim }

  const header = blessed.box({
    parent: s, top: 0, left: 0, width: '100%', height: 3,
    tags: true, style: { bg: t.bg, fg: t.fg },
  })

  const actionsBox = blessed.box({
    parent: s, top: 3, left: 0, width: '30%', height: '42%-2',
    border: { type: 'line' },
    label: ` {${t.accent}-fg}ACCIONES{/${t.accent}-fg} `,
    tags: true, style: { border: { fg: t.borderFocus }, bg: t.bg, fg: t.fg },
  })

  const qrBox = blessed.box({
    parent: s, top: '42%+1', left: 0, width: '30%', height: '58%-4',
    border: { type: 'line' },
    label: ` {${t.accent}-fg}QR{/${t.accent}-fg} `,
    tags: true, scrollable: true,
    style: { border: dimBorder, bg: t.bg, fg: t.fg },
  })

  const roomBox = blessed.box({
    parent: s, top: 3, left: '30%', width: '46%', height: '52%-1',
    border: { type: 'line' },
    label: ` {${t.accent}-fg}SALA ACTUAL{/${t.accent}-fg} `,
    tags: true, style: { border: dimBorder, bg: t.bg, fg: t.fg },
  })

  const transfersBox = blessed.box({
    parent: s, top: '52%+2', left: '30%', width: '46%', height: '48%-5',
    border: { type: 'line' },
    label: ` {${t.accent}-fg}TRANSFERENCIAS{/${t.accent}-fg} `,
    tags: true, scrollable: true,
    style: { border: dimBorder, bg: t.bg, fg: t.fg },
  })

  const peersBox = blessed.box({
    parent: s, top: 3, left: '76%', width: '24%', height: '35%-1',
    border: { type: 'line' },
    label: ` {${t.accent}-fg}PEERS{/${t.accent}-fg} `,
    tags: true, style: { border: dimBorder, bg: t.bg, fg: t.fg },
  })

  const activityBox = blessed.box({
    parent: s, top: '35%+2', left: '76%', width: '24%', height: '65%-5',
    border: { type: 'line' },
    label: ` {${t.accent}-fg}ACTIVIDAD{/${t.accent}-fg} `,
    tags: true, scrollable: true,
    style: { border: dimBorder, bg: t.bg, fg: t.fg },
  })

  const footer = blessed.box({
    parent: s, bottom: 0, left: 0, width: '100%', height: 3,
    tags: true, style: { bg: t.bg, fg: t.fg },
  })

  const panels = [actionsBox, roomBox, transfersBox, peersBox, activityBox]
  const panelLabels = ['ACCIONES', 'SALA ACTUAL', 'TRANSFERENCIAS', 'PEERS', 'ACTIVIDAD']

  return { header, actionsBox, qrBox, roomBox, transfersBox, peersBox, activityBox, footer, panels, panelLabels }
}

export function applyFocus(set: PanelSet, idx: number, t: Theme): void {
  set.panels.forEach((p, i) => {
    const focused = i === idx
    p.style.border = { fg: focused ? t.borderFocus : t.borderDim }
    const base = set.panelLabels[i]
    p.setLabel(
      focused
        ? ` {${t.borderFocus}-fg}► ${base}{/${t.borderFocus}-fg} `
        : ` {${t.accent}-fg}${base}{/${t.accent}-fg} `
    )
  })
}

export function applyThemeToLayout(set: PanelSet, t: Theme): void {
  const all = [set.actionsBox, set.qrBox, set.roomBox, set.transfersBox, set.peersBox, set.activityBox]
  all.forEach((p) => { p.style.bg = t.bg; p.style.fg = t.fg })
  set.header.style.bg = t.bg
  set.footer.style.bg = t.bg
}
