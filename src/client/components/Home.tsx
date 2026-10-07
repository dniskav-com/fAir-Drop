import React, { useRef, useState } from 'react'
import type { AppState } from '../app/state'
import BrandMark from './BrandMark'
import RoomCodeInput from './RoomCodeInput'
import { startQrScanner, stopQrScanner } from '../features/qr/application/qr-scanner'
import { useTranslation } from '../i18n'
import { getSavedSession, type SavedSession } from '../../core/store'

type HomeActions = {
  createRoom(): void
  joinRoom(code: string): void
  rejoinSaved(saved: SavedSession): void
}

export default function Home({ state, actions }: { state: AppState; actions: HomeActions }) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const saved = getSavedSession()

  const dialogRef = useRef<HTMLDialogElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)

  function onCreate() {
    actions.createRoom()
  }

  function onJoin(e?: React.FormEvent) {
    e?.preventDefault()
    actions.joinRoom(code.trim().toUpperCase())
  }

  function onScan() {
    if (!dialogRef.current || !videoRef.current || !statusRef.current) return
    void startQrScanner(
      {
        qrScanner: dialogRef.current,
        qrVideo: videoRef.current,
        scannerStatus: statusRef.current,
      },
      (msg) => {
        console.warn('[QR]', msg)
      },
      (detectedCode) => {
        setCode(detectedCode)
        actions.joinRoom(detectedCode)
      },
    )
  }

  function onCloseScanner() {
    if (!dialogRef.current || !videoRef.current) return
    stopQrScanner({ qrScanner: dialogRef.current, qrVideo: videoRef.current })
  }

  return (
    <section id="screen-home" className="screen active" aria-labelledby="home-title">
      <div className="brand-lockup">
        <BrandMark onClick={onCreate} />
        <p className="eyebrow">{t.home.tapToCreate}</p>
        <p className="brand-sub">{t.home.localNetwork}</p>
        <h1 id="home-title">fAir Drop</h1>
        <p className="tagline">{t.home.tagline}</p>
      </div>

      <form className="home-actions" onSubmit={onJoin} autoComplete="off">
        {saved ? (
          <button
            className="btn btn-secondary rejoin-chip"
            type="button"
            onClick={() => actions.rejoinSaved(saved)}
          >
            {t.home.reconnect} · {saved.code}
          </button>
        ) : null}
        <div className="divider" role="separator">
          <span>{t.home.or}</span>
        </div>
        <RoomCodeInput
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
        />
        <button className="btn btn-ghost" type="button" onClick={onScan}>
          {t.home.scanQr}
        </button>
        {state.homeError ? (
          <p className="error-msg" role="status" aria-live="polite">
            {state.homeError}
          </p>
        ) : null}
      </form>

      <dialog
        ref={dialogRef}
        className="scanner-dialog"
        aria-labelledby="scanner-title"
        onClose={onCloseScanner}
      >
        <div className="scanner-card">
          <div className="scanner-header">
            <h2 id="scanner-title">{t.home.scanner.title}</h2>
            <button className="btn-icon" type="button" onClick={onCloseScanner}>
              {t.home.scanner.close}
            </button>
          </div>
          <video ref={videoRef} className="qr-video" playsInline muted />
          <p ref={statusRef} className="scanner-status">
            {t.home.scanner.aim}
          </p>
        </div>
      </dialog>
    </section>
  )
}
