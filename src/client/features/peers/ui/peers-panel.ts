import type { AppState } from '../../../app/state.js'
import PeersPanel from '../../../components/PeersPanel'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import React from 'react'

export function renderClients(
  state: AppState,
  clientsList: HTMLUListElement,
  actions: { kickPeer(): void; banPeer(duration: number | null): void }
): void {
  // clear any previous interval-based timer (legacy)
  if (state.clientsTimer) {
    window.clearInterval(state.clientsTimer)
    state.clientsTimer = undefined as any
  }

  // create or reuse a React root attached to the clientsList container
  const anyEl = clientsList as any
  let root: Root | undefined = anyEl.__fairdropRoot
  if (!root) {
    root = createRoot(clientsList)
    anyEl.__fairdropRoot = root
  }

  root.render(React.createElement(PeersPanel, { state, actions }))
}
