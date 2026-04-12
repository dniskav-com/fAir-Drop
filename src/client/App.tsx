import React, { useEffect } from 'react'
import { FairDropStore } from '../core/store'
import type { ExpiryConfig } from '../core/store'
import { useFairDrop } from './adapters/react/useFairDrop'
import Home from './components/Home'
import Room from './components/Room'

// Store a nivel de módulo: una sola instancia para toda la app
const store = new FairDropStore()

export default function App() {
  const { state } = useFairDrop(store)

  // Clases CSS de dispositivo, auto-join desde URL y limpieza al salir
  useEffect(() => {
    const isMobile =
      matchMedia('(pointer: coarse)').matches ||
      /mobile|android|iphone|ipad/i.test(navigator.userAgent)
    document.documentElement.classList.toggle('is-mobile', isMobile)
    document.documentElement.classList.toggle('is-desktop', !isMobile)

    const room = new URLSearchParams(location.search).get('room')
    if (room && /^[A-Z0-9]{4}$/i.test(room)) {
      store.joinRoom(room.toUpperCase())
    }

    // Cerrar el WebSocket antes de recargar/salir para que el servidor limpie
    // la sala inmediatamente. Sin esto, iOS/Android mantiene el socket vivo y
    // el servidor cree que el creador sigue presente (sala zombie).
    const onUnload = () => store.disconnect()
    window.addEventListener('beforeunload', onUnload)
    ;(window as any).__fairdrop = store
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      try {
        delete (window as any).__fairdrop
      } catch {}
    }
  }, [])

  if (state.screen === 'room') {
    return (
      <Room
        state={state}
        actions={{
          sendFiles: (files: File[], expiry: ExpiryConfig | null) => store.sendFiles(files, expiry),
          deleteFile: (id: string) => store.deleteFile(id),
          downloadFile: (id: string) => store.recordDownload(id),
          kickPeer: () => store.kickPeer(),
          banPeer: (duration: number | null) => store.banPeer(duration),
          leaveRoom: () => store.leaveRoom(),
        }}
      />
    )
  }

  return (
    <Home
      state={state}
      actions={{
        createRoom: () => store.createRoom(),
        joinRoom: (code: string) => store.joinRoom(code),
      }}
    />
  )
}
