export interface Translations {
  home: {
    tapToCreate: string
    localNetwork: string
    tagline: string
    or: string
    scanQr: string
    scanner: {
      title: string
      close: string
      aim: string
    }
  }
  room: {
    copy: string
    copied: string
    leave: string
    leaveTitle: string
    leaveConfirm: string
    leaveConfirmMobile: string
    cancel: string
    ariaRoomCode: string
    ariaCopyCode: string
    ariaLeave: string
    status: {
      waiting: string
      connected: string
      relay: string
      disconnected: string
    }
    relayWarning: string
    retryP2p: string
    shareLabel: string
    copyLink: string
    share: string
    waitingPeer: string
    shareToConnect: string
    dropFiles: string
    dropClick: string
    selectFiles: string
    expiryOptions: string
    expiresIn: string
    sec: string
    max: string
    downloads: string
    filesTitle: string
    connectionsTitle: string
    scanQrPrompt: string
  }
  peers: {
    creator: string
    guest: string
    you: string
    connectedSince: string
    kick: string
    banPermanent: string
    banTemporary: string
    sec: string
    waiting: string
    notConnected: string
  }
  files: {
    sending: string
    receiving: string
    delete: string
    download: string
    sent: string
    noFiles: string
  }
  theme: {
    toLight: string
    toDark: string
    light: string
    dark: string
  }
}

export type Locale = 'es' | 'en' | 'fr' | 'de'
