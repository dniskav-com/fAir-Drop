import * as blessed from 'blessed'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { formatBytes } from '../utils'
import { tag, bold } from './helpers'
import { THEMES } from './themes'
import type { ExpiryConfig } from '../types'

// ── Text input ────────────────────────────────────────────────────────────────

export interface TextInputOptions {
  title: string
  prompt: string
  hint?: string
  defaultValue?: string
  width?: number
}

export function showTextInput(
  screen: blessed.Widgets.Screen,
  opts: TextInputOptions
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const close = (val: string | null) => {
      if (done) return; done = true
      box.destroy(); screen.render(); resolve(val)
    }

    const box = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: opts.width ?? 60, height: 9,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' }, bg: 'black', fg: 'white' },
      label: ` {cyan-fg}${opts.title}{/cyan-fg} `,
      tags: true, keys: true,
    })

    blessed.text({
      parent: box, top: 1, left: 2, right: 2,
      content: opts.prompt, tags: true,
      style: { bg: 'black', fg: 'white' },
    })

    const input = blessed.textbox({
      parent: box, top: 3, left: 2, right: 2, height: 1,
      style: { bg: '#111133', fg: 'cyan', focus: { bg: '#1a1a44' } },
      keys: true, inputOnFocus: true, mouse: true,
    })

    blessed.text({
      parent: box, bottom: 1, left: 2,
      content: opts.hint ?? '{gray-fg}Enter confirmar  Esc cancelar{/gray-fg}',
      tags: true, style: { bg: 'black' },
    })

    if (opts.defaultValue) input.setValue(opts.defaultValue)
    input.on('submit', (val: string) => close(val?.trim() ?? ''))
    input.on('cancel', () => close(null))

    input.focus()
    screen.render()
  })
}

// ── File browser ──────────────────────────────────────────────────────────────

export function showFileBrowser(
  screen: blessed.Widgets.Screen,
  startDir = os.homedir()
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    let currentDir = startDir
    let filePaths: string[] = []

    const close = (val: string | null) => {
      if (done) return; done = true
      box.destroy(); screen.render(); resolve(val)
    }

    const box = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: '72%', height: '72%',
      border: { type: 'line' },
      style: { border: { fg: 'cyan' }, bg: 'black' },
      label: ' {cyan-fg}Explorar archivo{/cyan-fg} ',
      tags: true,
    })

    const pathBar = blessed.text({
      parent: box, top: 0, left: 1, right: 1, height: 1,
      tags: true, style: { bg: 'black', fg: 'cyan' },
    })

    const list = blessed.list({
      parent: box, top: 2, left: 1, right: 1, bottom: 2,
      style: {
        bg: 'black', fg: 'white',
        item: { bg: 'black', fg: 'white' },
        selected: { bg: 'blue', fg: 'white', bold: true },
      },
      keys: true, vi: false, mouse: true, scrollable: true,
    })

    blessed.text({
      parent: box, bottom: 0, left: 1,
      content: 'navegacion: ↑/↓   Enter abrir/seleccionar   Esc cancelar',
      tags: false, style: { bg: 'black', fg: 'gray' },
    })

    // ANSI codes: bypass blessed tag pipeline which doesn't apply to list items
    const C = {
      yellow: '\x1b[33m',
      cyan:   '\x1b[36m',
      gray:   '\x1b[90m',
      red:    '\x1b[31m',
      reset:  '\x1b[0m',
    }

    function loadDir(dir: string): void {
      currentDir = dir
      pathBar.setContent(tag('cyan', dir))
      filePaths = []
      const items: string[] = []

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
            return a.name.localeCompare(b.name)
          })

        filePaths.push('..')
        items.push(`  ${C.yellow}[..] subir directorio${C.reset}`)

        for (const e of entries) {
          if (e.name.startsWith('.')) continue
          const full = path.join(dir, e.name)
          if (e.isDirectory()) {
            filePaths.push(full)
            items.push(`  ${C.yellow}> ${C.cyan}${e.name}/${C.reset}`)
          } else if (e.isFile()) {
            let sizeStr = ''
            try { sizeStr = `  ${C.gray}${formatBytes(fs.statSync(full).size)}${C.reset}` } catch {}
            filePaths.push(full)
            items.push(`  ${C.gray}- ${C.reset}${e.name}${sizeStr}`)
          }
        }
      } catch {
        items.push(`  ${C.red}Error: no se puede leer este directorio${C.reset}`)
      }

      list.setItems(items)
      list.select(0)
      list.focus()
      screen.render()
    }

    const selectAt = (index: number): void => {
      const target = filePaths[index]
      if (!target) return
      if (target === '..') { loadDir(path.dirname(currentDir)); return }
      try {
        if (fs.statSync(target).isDirectory()) { loadDir(target); return }
      } catch { return }
      close(target)
    }

    // 'select' fires on Enter with the correct index from blessed's internal tracking
    list.on('select', (_item: unknown, index: number) => selectAt(index))
    list.key(['escape'], () => close(null))

    loadDir(startDir)
    list.focus()
    screen.render()
  })
}

// ── Download confirm ──────────────────────────────────────────────────────────

export function showDownloadConfirm(
  screen: blessed.Widgets.Screen,
  name: string,
  size: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let choice = true

    const close = (val: boolean) => {
      if (done) return; done = true
      ;(['left', 'right', 'tab', 'enter', 'escape', 'y', 's', 'n'] as string[])
        .forEach((k) => screen.unkey(k, handler))
      box.destroy(); screen.render(); resolve(val)
    }

    const box = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 62, height: 12,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' }, bg: 'black', fg: 'white' },
      label: ' {cyan-fg}Archivo recibido{/cyan-fg} ',
      tags: true,
    })

    blessed.text({
      parent: box, top: 1, left: 2, right: 2,
      content: `  {white-fg}${bold(name)}{/white-fg}\n  ${tag('gray', formatBytes(size))}`,
      tags: true, style: { bg: 'black' },
    })

    blessed.text({
      parent: box, top: 4, left: 2,
      content: '¿Descargar este archivo?',
      tags: true, style: { bg: 'black', fg: 'white' },
    })

    const btnYes = blessed.box({
      parent: box, bottom: 2, left: 4,
      width: 20, height: 3, border: { type: 'line' },
      content: `  {green-fg}✓ Descargar{/green-fg}  `,
      tags: true, style: { border: { fg: 'green' }, bg: 'black' },
    })

    const btnNo = blessed.box({
      parent: box, bottom: 2, right: 4,
      width: 20, height: 3, border: { type: 'line' },
      content: `  {red-fg}✗ Rechazar{/red-fg}   `,
      tags: true, style: { border: { fg: 'gray' }, bg: 'black' },
    })

    blessed.text({
      parent: box, bottom: 0, left: 2,
      content: '{gray-fg}←/→ o Tab elegir   Enter confirmar   y/n atajo{/gray-fg}',
      tags: true, style: { bg: 'black' },
    })

    const updateButtons = (): void => {
      btnYes.style.border.fg = choice ? 'green' : 'gray'
      btnNo.style.border.fg  = choice ? 'gray'  : 'red'
      screen.render()
    }

    const handler = (_ch: string, key: { name: string }): void => {
      switch (key.name) {
        case 'left': case 'right': case 'tab': choice = !choice; updateButtons(); break
        case 'enter': close(choice); break
        case 'y': case 's': close(true); break
        case 'n': case 'escape': close(false); break
      }
    }

    screen.key(['left', 'right', 'tab', 'enter', 'escape', 'y', 's', 'n'], handler)
    updateButtons()
    box.focus()
    screen.render()
  })
}

// ── Send options ──────────────────────────────────────────────────────────────

export function showSendOptions(
  screen: blessed.Widgets.Screen,
  name: string,
  size: number
): Promise<ExpiryConfig | null | false> {
  return new Promise((resolve) => {
    let done = false
    let focusIdx = 0
    const focusables: blessed.Widgets.BlessedElement[] = []

    const close = (val: ExpiryConfig | null | false): void => {
      if (done) return; done = true
      ;(['tab', 'escape'] as string[]).forEach((k) => screen.unkey(k, tabHandler))
      box.destroy(); screen.render(); resolve(val)
    }

    const box = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 64, height: 16,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' }, bg: 'black', fg: 'white' },
      label: ' {cyan-fg}Opciones de envío{/cyan-fg} ',
      tags: true,
    })

    blessed.text({
      parent: box, top: 1, left: 2,
      content: `Archivo: {white-fg}${name}{/white-fg}  {gray-fg}(${formatBytes(size)}){/gray-fg}`,
      tags: true, style: { bg: 'black' },
    })

    blessed.text({
      parent: box, top: 3, left: 2,
      content: `{gray-fg}⏱  Expiración en minutos {yellow-fg}(vacío = sin límite){/yellow-fg}:{/gray-fg}`,
      tags: true, style: { bg: 'black' },
    })

    const timeInput = blessed.textbox({
      parent: box, top: 4, left: 2, width: 20, height: 1,
      style: { bg: '#111133', fg: 'cyan', focus: { bg: '#1a1a55' } },
      keys: true, inputOnFocus: true, mouse: true,
    })
    focusables.push(timeInput)

    blessed.text({
      parent: box, top: 7, left: 2,
      content: `{gray-fg}⬇  Límite de descargas {yellow-fg}(vacío = sin límite){/yellow-fg}:{/gray-fg}`,
      tags: true, style: { bg: 'black' },
    })

    const dlInput = blessed.textbox({
      parent: box, top: 8, left: 2, width: 20, height: 1,
      style: { bg: '#111133', fg: 'cyan', focus: { bg: '#1a1a55' } },
      keys: true, inputOnFocus: true, mouse: true,
    })
    focusables.push(dlInput)

    const btnSend = blessed.box({
      parent: box, bottom: 2, left: 6,
      width: 16, height: 3, border: { type: 'line' },
      content: `  {green-fg}✓ Enviar{/green-fg}    `,
      tags: true,
      style: { border: { fg: 'green' }, bg: 'black' },
      mouse: true,
    })
    focusables.push(btnSend)

    const btnCancel = blessed.box({
      parent: box, bottom: 2, right: 6,
      width: 16, height: 3, border: { type: 'line' },
      content: `  {gray-fg}✗ Cancelar{/gray-fg}  `,
      tags: true,
      style: { border: { fg: 'gray' }, bg: 'black' },
      mouse: true,
    })
    focusables.push(btnCancel)

    blessed.text({
      parent: box, bottom: 0, left: 2,
      content: '{gray-fg}Tab navegar   Enter confirmar   Esc cancelar{/gray-fg}',
      tags: true, style: { bg: 'black' },
    })

    const doSend = (): void => {
      const mins = parseInt(timeInput.getValue() || '0', 10) || 0
      const dls  = parseInt(dlInput.getValue()  || '0', 10) || 0
      const expiry: ExpiryConfig = {}
      if (mins > 0) expiry.time = mins * 60
      if (dls > 0)  expiry.downloads = dls
      close(Object.keys(expiry).length > 0 ? expiry : null)
    }

    const tabHandler = (_ch: string, key: { name: string }): void => {
      if (key.name === 'escape') { close(false); return }
      if (key.name === 'tab') {
        focusIdx = (focusIdx + 1) % focusables.length
        focusables[focusIdx].focus()
        screen.render()
      }
    }
    screen.key(['tab', 'escape'], tabHandler)

    timeInput.on('submit', () => { focusIdx = 1; dlInput.focus(); screen.render() })
    dlInput.on('submit', doSend)
    timeInput.on('cancel', () => close(false))
    dlInput.on('cancel', () => close(false))
    btnSend.on('click', doSend)
    btnCancel.on('click', () => close(false))

    timeInput.focus()
    screen.render()
  })
}

// ── Theme selector ────────────────────────────────────────────────────────────

export function showThemeSelector(
  screen: blessed.Widgets.Screen,
  current: string
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const themes = Object.keys(THEMES)
    let selected = Math.max(0, themes.indexOf(current))

    const close = (val: string | null): void => {
      if (done) return; done = true
      ;(['up', 'down', 'enter', 'escape'] as string[]).forEach((k) => screen.unkey(k, handler))
      box.destroy(); screen.render(); resolve(val)
    }

    const box = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 36, height: themes.length + 6,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' }, bg: 'black', fg: 'white' },
      label: ' {cyan-fg}Seleccionar tema{/cyan-fg} ',
      tags: true,
    })

    blessed.text({
      parent: box, top: 1, left: 2,
      content: '{gray-fg}↑/↓ seleccionar   Enter aplicar{/gray-fg}',
      tags: true, style: { bg: 'black' },
    })

    const renderList = (): void => {
      themes.forEach((key, i) => {
        const t = THEMES[key]
        const isSelected = i === selected
        const marker = isSelected ? `{cyan-fg}▶{/cyan-fg}` : ' '
        const isCurrent = key === current ? ` {gray-fg}(actual){/gray-fg}` : ''
        blessed.text({
          parent: box, top: 2 + i, left: 2,
          content: `${marker} ${t.name}${isCurrent}`,
          tags: true,
          style: { bg: isSelected ? '#1a1a44' : 'black', fg: 'white' },
        })
      })
    }

    renderList()

    const handler = (_ch: string, key: { name: string }): void => {
      if (key.name === 'up') {
        selected = Math.max(0, selected - 1)
        box.children.slice(2).forEach((c) => c.destroy())
        renderList()
        screen.render()
      } else if (key.name === 'down') {
        selected = Math.min(themes.length - 1, selected + 1)
        box.children.slice(2).forEach((c) => c.destroy())
        renderList()
        screen.render()
      } else if (key.name === 'enter') {
        close(themes[selected])
      } else if (key.name === 'escape') {
        close(null)
      }
    }

    screen.key(['up', 'down', 'enter', 'escape'], handler)
    box.focus()
    screen.render()
  })
}

// ── Toast ─────────────────────────────────────────────────────────────────────

export function showToast(
  screen: blessed.Widgets.Screen,
  msg: string,
  type: 'error' | 'warning' | 'info' = 'info'
): void {
  const fg = type === 'error' ? 'red' : type === 'warning' ? 'yellow' : 'cyan'
  const label = type === 'error' ? 'Error' : 'Aviso'
  let closed = false

  const box = blessed.box({
    parent: screen,
    top: 'center', left: 'center',
    width: 62, height: 8,
    border: { type: 'line' },
    label: ` {${fg}-fg}${label}{/${fg}-fg} `,
    tags: true,
    style: { bg: 'black', fg, border: { fg } },
    content: `\n  ${msg}\n\n  {gray-fg}Presiona Enter o Esc para cerrar{/gray-fg}`,
  })

  const close = (): void => {
    if (closed) return; closed = true
    ;(['enter', 'escape'] as string[]).forEach((k) => screen.unkey(k, close))
    clearTimeout(timer)
    try { box.destroy() } catch {}
    screen.render()
  }

  screen.key(['enter', 'escape'], close)
  const timer = setTimeout(close, 5000)
  screen.render()
}
