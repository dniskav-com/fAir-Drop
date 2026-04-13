import { useEffect } from 'react'
import { FairDropStore } from '../core/store'
import type { ExpiryConfig } from '../core/store'
import { useFairDrop } from './adapters/react/useFairDrop'
import Home from './components/Home'
import Room from './components/Room'
import ThemeToggle from './components/ThemeToggle'
import LanguageSelector from './components/LanguageSelector'
import { useTheme } from './hooks/useTheme'
import { LocaleProvider } from './i18n'

const store = new FairDropStore()

function AppInner() {
  const { state } = useFairDrop(store)
  const { theme, toggle } = useTheme()

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
        theme={theme}
        onToggleTheme={toggle}
        actions={{
          sendFiles: (files: File[], expiry: ExpiryConfig | null) => store.sendFiles(files, expiry),
          deleteFile: (id: string) => store.deleteFile(id),
          downloadFile: (id: string) => store.recordDownload(id),
          kickPeer: () => store.kickPeer(),
          banPeer: (duration: number | null) => store.banPeer(duration),
          leaveRoom: () => store.leaveRoom(),
          retryP2P: () => store.retryP2P(),
        }}
      />
    )
  }

  return (
    <>
      <div className="home-controls">
        <LanguageSelector />
        <ThemeToggle theme={theme} onToggle={toggle} inline />
      </div>
      <Home
        state={state}
        actions={{
          createRoom: () => store.createRoom(),
          joinRoom: (code: string) => store.joinRoom(code),
        }}
      />
    </>
  )
}

export default function App() {
  return (
    <LocaleProvider>
      <AppInner />
    </LocaleProvider>
  )
}
