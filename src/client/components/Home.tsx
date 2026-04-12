import React, { useRef, useState } from 'react'
import type { AppState } from '../app/state'
import BrandMark from './BrandMark'
import RoomCodeInput from './RoomCodeInput'
import { startQrScanner, stopQrScanner } from '../features/qr/application/qr-scanner'

type HomeActions = {
  createRoom(): void
  joinRoom(code: string): void
}

export default function Home({ state, actions }: { state: AppState; actions: HomeActions }) {
  const [code, setCode] = useState('')

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
        // homeError llega a través del store; no tenemos acceso directo aquí,
        // pero el store ya lo maneja internamente
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
        <p className="eyebrow">Toca para crear sala</p>
        <p className="brand-sub">red local</p>
        <h1 id="home-title">fAir Drop</h1>
        <p className="tagline">Pasa archivos directo entre tus dispositivos.</p>
      </div>

      <form className="home-actions" onSubmit={onJoin} autoComplete="off">
        <div className="divider" role="separator">
          <span>o</span>
        </div>
        <RoomCodeInput
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
        />
        <button className="btn btn-ghost" type="button" onClick={onScan}>
          Escanear QR
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
            <h2 id="scanner-title">Escanear sala</h2>
            <button className="btn-icon" type="button" onClick={onCloseScanner}>
              Cerrar
            </button>
          </div>
          <video ref={videoRef} className="qr-video" playsInline muted />
          <p ref={statusRef} className="scanner-status">
            Apunta la camara al QR.
          </p>
        </div>
      </dialog>
    </section>
  )
}
