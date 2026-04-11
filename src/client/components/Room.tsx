import React from 'react'
import PeersPanel from './PeersPanel'
import FileList from './FileList'
import { sendFilesReact } from '../features/transfer/application/transfer'

export default function Room({ state, actions, code, isCreator }: any) {
  const hasFiles = state.incoming.size > 0 || state.fileUrls.size > 0
  const dropClass = state.peerInfo ? 'drop-zone' : 'drop-zone disabled'

  // local file input for React-managed uploads
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    if (files.length === 0) return
    // No expiry UI in the React drop yet; send with default expiry (null)
    try {
      await sendFilesReact(state, files)
    } catch (err) {
      console.error('sendFilesReact error', err)
    }
    // reset input so same file selection can be re-used
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="room-react-root">
      <header className="room-header">
        <h1 id="room-title" className="logo-small">
          fAir Drop
        </h1>
        <div className="room-info" aria-label="Codigo de sala">
          <span id="room-code-display-react" className="room-code">
            {code}
          </span>
          <button
            id="btn-copy-code-react"
            className="btn-icon"
            type="button"
            aria-label="Copiar codigo"
            onClick={actions.copyCode}>
            Copiar
          </button>
        </div>
        <div
          id="connection-status-react"
          className={`status status-waiting`}
          role="status"
          aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <span id="status-text-react">Esperando...</span>
        </div>
      </header>

      <section className="room-main" aria-label="Transferencia de archivos">
        <div
          id="drop-zone-react"
          className={dropClass}
          onClick={() => fileInputRef.current?.click()}>
          <div className="drop-content">
            <span className="drop-icon">+</span>
            <p className="drop-label">Arrastra archivos aqui</p>
            <p className="drop-sub">o haz clic en cualquier parte</p>
            <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
              Seleccionar archivos
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={onFilesSelected} />
          </div>
        </div>

        <section
          id="file-list-section-react"
          className={'file-list-section ' + (hasFiles ? '' : 'hidden')}
          aria-labelledby="files-title">
          <h2 id="files-title" className="section-title">
            Archivos
          </h2>
          {/* FileList will render incoming and completed files from state */}
          <div id="file-list-react-root">
            <FileList
              state={state}
              actions={{ deleteFile: actions.deleteFile, downloadFile: actions.downloadFile }}
            />
          </div>
        </section>
      </section>

      <aside className="clients-panel" aria-labelledby="clients-title">
        <h2 id="clients-title" className="section-title">
          Conexiones
        </h2>
        <PeersPanel
          state={state}
          actions={{ kickPeer: actions.kickPeer, banPeer: actions.banPeer }}
        />
        <figure className="qr-card qr-card--sidebar">
          <img
            id="room-qr-react"
            className="room-qr"
            alt="QR para entrar a la sala"
            src={
              isCreator ? `/api/qr?text=${encodeURIComponent(actions.shareLink ?? '')}` : undefined
            }
          />
          <figcaption>Escanea este QR desde el otro dispositivo.</figcaption>
        </figure>
      </aside>
    </div>
  )
}
