import type { AppState } from '@client/app/state'

export function showRoom(
  state: AppState,
  code: string,
  isCreator: boolean,
  notify: () => void,
): void {
  const shareUrl = isCreator ? `${location.origin}${location.pathname}?room=${code}` : null

  state.screen = 'room'
  state.roomCode = code
  state.isCreator = isCreator
  state.shareUrl = shareUrl
  history.replaceState(null, '', `?room=${code}`)
  notify()
}

export function resetToHome(
  state: AppState,
  message: string | undefined,
  notify: () => void,
): void {
  state.pc?.close()
  state.ws?.close()
  state.pc = null
  state.dc = null
  state.ws = null
  state.useRelay = false
  state.relayRequested = false
  state.selfInfo = null
  state.peerInfo = null
  state.roomCode = null
  state.shareUrl = null
  state.screen = 'home'
  state.connectionStatus = 'waiting'
  if (state.clientsTimer) window.clearInterval(state.clientsTimer)
  state.clientsTimer = null
  history.replaceState(null, '', '/')

  if (message) {
    state.homeError = message
    window.setTimeout(() => {
      state.homeError = null
      notify()
    }, 5000)
  }

  notify()
}
