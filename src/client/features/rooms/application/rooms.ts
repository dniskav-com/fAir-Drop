import type { AppState } from '../../../app/state.js'
import type { DomRefs } from '../../../shared/adapters/dom.js'

export function showRoom(state: AppState, dom: DomRefs, code: string, isCreator: boolean): void {
  dom.screenHome.classList.remove('active')
  dom.screenRoom.classList.add('active')
  dom.roomCodeDisplay.textContent = code
  history.replaceState(null, '', `?room=${code}`)
  // clear creating visual state on the logo
  try {
    dom.brandMark.classList.remove('creating')
    dom.brandMark.setAttribute('aria-pressed', 'false')
  } catch (e) {}
  if (isCreator) {
    const link = `${location.origin}${location.pathname}?room=${code}`
    dom.shareUrl.textContent = link
    dom.roomQr.src = `/api/qr?text=${encodeURIComponent(link)}`
    dom.shareBanner.classList.remove('hidden')
    dom.roomQrCard.classList.remove('hidden')
  } else {
    dom.shareBanner.classList.add('hidden')
    dom.roomQrCard.classList.add('hidden')
  }
}

export function resetToHome(state: AppState, dom: DomRefs, message?: string): void {
  state.pc?.close()
  state.ws?.close()
  state.pc = null
  state.dc = null
  state.ws = null
  state.useRelay = false
  state.relayRequested = false
  state.selfInfo = null
  state.peerInfo = null
  if (state.clientsTimer) window.clearInterval(state.clientsTimer)
  state.clientsTimer = null
  dom.clientsList.innerHTML = '<li class="client-empty">Esperando...</li>'
  dom.roomQr.removeAttribute('src')
  history.replaceState(null, '', '/')
  dom.screenRoom.classList.remove('active')
  dom.screenHome.classList.add('active')
  // React UI is no longer mounted
  state.uiReact = false
  try {
    dom.brandMark.classList.remove('creating')
    dom.brandMark.setAttribute('aria-pressed', 'false')
  } catch (e) {}
  if (message) {
    dom.homeError.textContent = message
    dom.homeError.classList.remove('hidden')
    window.setTimeout(() => dom.homeError.classList.add('hidden'), 5000)
  }
}
