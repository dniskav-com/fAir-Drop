import React, { useState } from 'react'

function dispatch(name: string, detail?: any) {
  document.dispatchEvent(new CustomEvent(name, { detail }))
}

export default function Home(): JSX.Element {
  const [code, setCode] = useState('')

  function onCreate() {
    dispatch('app:create-room')
  }

  function onJoin(e?: React.FormEvent) {
    e?.preventDefault()
    dispatch('app:join-room', { code: code.trim().toUpperCase() })
  }

  function onScan() {
    dispatch('app:scan-qr')
  }

  return (
    <section className="screen active" aria-labelledby="home-title">
      <div className="brand-lockup">
        <div className="brand-mark" role="button" tabIndex={0} onClick={onCreate}>
          <span className="radar-ring" />
          <span className="radar-ring" />
          <span className="radar-ring" />
          <span className="radar-core" />
        </div>
        <p className="eyebrow">Toca para crear sala</p>
        <p className="brand-sub">red local</p>
        <h1 id="home-title">fAir Drop</h1>
        <p className="tagline">Pasa archivos directo entre tus dispositivos.</p>
      </div>

      <form className="home-actions" onSubmit={onJoin} autoComplete="off">
        <button id="btn-create-react" className="btn btn-primary" type="button" onClick={onCreate}>
          Crear sala
        </button>
        <div className="divider" role="separator">
          <span>o</span>
        </div>
        <div className="join-form">
          <label className="sr-only" htmlFor="input-code-react">
            Codigo de sala
          </label>
          <input
            id="input-code-react"
            type="text"
            placeholder="AB12"
            maxLength={4}
            inputMode="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            aria-describedby="home-error-react"
          />
          <button id="btn-join-react" className="btn btn-secondary" type="submit">
            Unirse
          </button>
        </div>
        <button id="btn-scan-qr-react" className="btn btn-ghost" type="button" onClick={onScan}>
          Escanear QR
        </button>
        <p id="home-error-react" className="error-msg hidden" role="status" aria-live="polite"></p>
      </form>
    </section>
  )
}
