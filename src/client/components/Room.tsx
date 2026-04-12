import React, { useRef, useState } from 'react'
import type { AppState } from '../app/state'
import type { ExpiryConfig } from '../shared/domain/types'
import PeersPanel from './PeersPanel'
import FileList from './FileList'

type RoomActions = {
  sendFiles(files: File[], expiry: ExpiryConfig | null): Promise<void>
  deleteFile(id: string): void
  downloadFile(id: string): void
  kickPeer(): void
  banPeer(duration: number | null): void
  leaveRoom(): void
}

const statusLabels: Record<string, string> = {
  waiting: 'Esperando...',
  connected: 'Conectado (P2P)',
  relay: 'Conectado (via servidor)',
  disconnected: 'Desconectado',
}

export default function Room({ state, actions }: { state: AppState; actions: RoomActions }) {
  const [expiry, setExpiry] = useState({
    timeEnabled: false,
    time: 30,
    dlEnabled: false,
    dl: 1,
  })
  const [isDragOver, setIsDragOver] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showExitModal, setShowExitModal] = useState(false)

  const isConnected = state.connectionStatus === 'connected' || state.connectionStatus === 'relay'
  const hasFiles = state.incoming.size > 0 || state.fileUrls.size > 0 || state.fileMeta.size > 0

  function getExpiryConfig(): ExpiryConfig | null {
    const cfg: ExpiryConfig = {}
    if (expiry.timeEnabled) cfg.time = expiry.time
    if (expiry.dlEnabled) cfg.downloads = expiry.dl
    return cfg.time || cfg.downloads ? cfg : null
  }

  async function sendSelected(files: File[]) {
    if (!files.length || !isConnected) return
    try {
      await actions.sendFiles(files, getExpiryConfig())
    } catch (err) {
      console.error('sendFiles error', err)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function copyCode() {
    if (!state.roomCode) return
    await navigator.clipboard.writeText(state.roomCode)
    setCopiedCode(true)
    setTimeout(() => setCopiedCode(false), 1600)
  }

  async function copyLink() {
    if (!state.shareUrl) return
    await navigator.clipboard.writeText(state.shareUrl)
    setCopiedLink(true)
    setTimeout(() => setCopiedLink(false), 1600)
  }

  async function nativeShare() {
    if (!state.shareUrl) return
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'fAir Drop',
          text: 'Entra a mi sala de fAir Drop',
          url: state.shareUrl,
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.warn('share failed', err)
      }
    }
    await copyLink()
  }

  return (
    <>
      <header className="room-header">
        <h1 className="logo-small">fAir Drop</h1>
        <div className="room-info" aria-label="Codigo de sala">
          <span className="room-code">{state.roomCode}</span>
          <button className="btn-icon" type="button" aria-label="Copiar codigo" onClick={copyCode}>
            {copiedCode ? 'Copiado' : 'Copiar'}
          </button>
          <button
            className="btn btn-destructive"
            type="button"
            aria-label="Salir de la sala"
            onClick={() => {
              const isMobile =
                matchMedia('(pointer: coarse)').matches ||
                /mobile|android|iphone|ipad/i.test(navigator.userAgent)
              if (isMobile) {
                const ok = window.confirm('¿Salir de la sala? La conexión se cerrará.')
                if (ok) actions.leaveRoom()
              } else {
                setShowExitModal(true)
              }
            }}
          >
            Salir
          </button>
        </div>
        <div className={`status status-${state.connectionStatus}`} role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <span>{statusLabels[state.connectionStatus] ?? ''}</span>
        </div>
        {state.roomError ? (
          <p className="error-msg" role="status" aria-live="polite">
            {state.roomError}
          </p>
        ) : null}
      </header>

      {showExitModal ? (
        <div className="confirm-backdrop" role="dialog" aria-modal="true">
          <div className="confirm-modal">
            <h3>Salir de la sala</h3>
            <p>¿Seguro que deseas salir? La conexión se cerrará.</p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setShowExitModal(false)}>
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setShowExitModal(false)
                  actions.leaveRoom()
                }}
              >
                Salir
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {state.connectionStatus === 'relay' ? (
        <div className="relay-warning" role="status" aria-live="polite">
          <strong>Atención:</strong> La conexión P2P ha fallado; los archivos se envían a través del
          servidor (relay).
        </div>
      ) : null}

      {state.isCreator && state.shareUrl ? (
        <aside className="share-banner" aria-label="Link para compartir">
          <p className="share-label">Comparte este link con el otro dispositivo:</p>
          <div className="share-row">
            <span className="share-url">{state.shareUrl}</span>
            <button className="btn btn-secondary" type="button" onClick={copyLink}>
              {copiedLink ? 'Copiado' : 'Copiar link'}
            </button>
            <button className="btn btn-secondary" type="button" onClick={nativeShare}>
              Compartir
            </button>
          </div>
        </aside>
      ) : null}

      <div className="room-body">
        <section className="room-main" aria-label="Transferencia de archivos">
          {/* Drop zone */}
          <div
            className={`drop-zone${!isConnected ? ' disabled' : ''}${isDragOver ? ' drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              if (isConnected) setIsDragOver(true)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setIsDragOver(false)
              void sendSelected(Array.from(e.dataTransfer?.files ?? []))
            }}
            onClick={(e) => {
              if (!isConnected) return
              if ((e.target as HTMLElement).closest('.expiry-bar')) return
              fileInputRef.current?.click()
            }}
          >
            {!isConnected ? (
              <div className="drop-content">
                <span className="drop-icon" aria-hidden="true">
                  ...
                </span>
                <p className="drop-label">Esperando al otro dispositivo...</p>
                <p className="drop-sub">Comparte el link para conectar</p>
              </div>
            ) : (
              <div className="drop-content">
                <span className="drop-icon" aria-hidden="true">
                  +
                </span>
                <p className="drop-label">Arrastra archivos aqui</p>
                <p className="drop-sub">o haz clic en cualquier parte</p>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    fileInputRef.current?.click()
                  }}
                >
                  Seleccionar archivos
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => void sendSelected(Array.from(e.target.files ?? []))}
                />

                <fieldset className="expiry-bar" onClick={(e) => e.stopPropagation()}>
                  <legend>Opciones</legend>
                  <label className="expiry-option">
                    <input
                      type="checkbox"
                      checked={expiry.timeEnabled}
                      onChange={(e) => setExpiry((x) => ({ ...x, timeEnabled: e.target.checked }))}
                    />
                    <span>Expira en</span>
                    <input
                      type="number"
                      className="expiry-input"
                      min={1}
                      max={3600}
                      value={expiry.time}
                      onChange={(e) =>
                        setExpiry((x) => ({ ...x, time: Number(e.target.value) || 30 }))
                      }
                    />
                    <span>seg</span>
                  </label>
                  <label className="expiry-option">
                    <input
                      type="checkbox"
                      checked={expiry.dlEnabled}
                      onChange={(e) => setExpiry((x) => ({ ...x, dlEnabled: e.target.checked }))}
                    />
                    <span>Max</span>
                    <input
                      type="number"
                      className="expiry-input"
                      min={1}
                      max={99}
                      value={expiry.dl}
                      onChange={(e) =>
                        setExpiry((x) => ({ ...x, dl: Number(e.target.value) || 1 }))
                      }
                    />
                    <span>descarga(s)</span>
                  </label>
                </fieldset>
              </div>
            )}
          </div>

          {hasFiles ? (
            <section className="file-list-section" aria-labelledby="files-title">
              <h2 id="files-title" className="section-title">
                Archivos
              </h2>
              <FileList
                state={state}
                actions={{
                  deleteFile: actions.deleteFile,
                  downloadFile: actions.downloadFile,
                }}
              />
            </section>
          ) : null}
        </section>

        <aside className="clients-panel" aria-labelledby="clients-title">
          <h2 id="clients-title" className="section-title">
            Conexiones
          </h2>
          <PeersPanel
            state={state}
            actions={{ kickPeer: actions.kickPeer, banPeer: actions.banPeer }}
          />
          {state.isCreator && state.shareUrl ? (
            <figure className="qr-card qr-card--sidebar">
              <img
                className="room-qr"
                alt="QR para entrar a la sala"
                src={`/api/qr?text=${encodeURIComponent(state.shareUrl)}`}
              />
              <figcaption>Escanea este QR desde el otro dispositivo.</figcaption>
            </figure>
          ) : null}
        </aside>
      </div>
    </>
  )
}
