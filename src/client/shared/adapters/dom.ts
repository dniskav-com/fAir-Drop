export interface DomRefs {
  screenHome: HTMLElement
  screenRoom: HTMLElement
  brandMark: HTMLElement
  btnJoin: HTMLButtonElement
  inputCode: HTMLInputElement
  homeError: HTMLElement
  roomError: HTMLElement
  roomCodeDisplay: HTMLElement
  btnCopyCode: HTMLButtonElement
  connectionStatus: HTMLElement
  statusText: HTMLElement
  dropZone: HTMLElement
  dropWaiting: HTMLElement
  dropReady: HTMLElement
  fileInput: HTMLInputElement
  fileListSection: HTMLElement
  fileList: HTMLUListElement
  shareBanner: HTMLElement
  shareUrl: HTMLElement
  btnCopyLink: HTMLButtonElement
  btnNativeShare: HTMLButtonElement
  btnScanQr: HTMLButtonElement
  qrScanner: HTMLDialogElement
  btnCloseScanner: HTMLButtonElement
  qrVideo: HTMLVideoElement
  scannerStatus: HTMLElement
  roomQr: HTMLImageElement
  roomQrCard: HTMLElement
  clientsList: HTMLUListElement
  expTimeOn: HTMLInputElement
  expTimeVal: HTMLInputElement
  expDlOn: HTMLInputElement
  expDlVal: HTMLInputElement
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing DOM element #${id}`)
  return el as T
}

export function getDomRefs(): DomRefs {
  return {
    screenHome: byId('screen-home'),
    screenRoom: byId('screen-room'),
    brandMark: byId('brand-mark'),
    btnJoin: byId('btn-join'),
    inputCode: byId<HTMLInputElement>('input-code'),
    homeError: byId('home-error'),
    roomError: byId('room-error'),
    roomCodeDisplay: byId('room-code-display'),
    btnCopyCode: byId<HTMLButtonElement>('btn-copy-code'),
    connectionStatus: byId('connection-status'),
    statusText: byId('status-text'),
    dropZone: byId('drop-zone'),
    dropWaiting: byId('drop-waiting'),
    dropReady: byId('drop-ready'),
    fileInput: byId<HTMLInputElement>('file-input'),
    fileListSection: byId('file-list-section'),
    fileList: byId<HTMLUListElement>('file-list'),
    shareBanner: byId('share-banner'),
    shareUrl: byId('share-url'),
    btnCopyLink: byId<HTMLButtonElement>('btn-copy-link'),
    btnNativeShare: byId<HTMLButtonElement>('btn-native-share'),
    btnScanQr: byId<HTMLButtonElement>('btn-scan-qr'),
    qrScanner: byId<HTMLDialogElement>('qr-scanner'),
    btnCloseScanner: byId<HTMLButtonElement>('btn-close-scanner'),
    qrVideo: byId<HTMLVideoElement>('qr-video'),
    scannerStatus: byId('scanner-status'),
    roomQr: byId<HTMLImageElement>('room-qr'),
    roomQrCard: byId('room-qr-card'),
    clientsList: byId<HTMLUListElement>('clients-list'),
    expTimeOn: byId<HTMLInputElement>('exp-time-on'),
    expTimeVal: byId<HTMLInputElement>('exp-time-val'),
    expDlOn: byId<HTMLInputElement>('exp-dl-on'),
    expDlVal: byId<HTMLInputElement>('exp-dl-val'),
  }
}
