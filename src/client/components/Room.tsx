import React, { useRef, useState } from 'react'
import type { AppState } from '../app/state'
import type { ExpiryConfig } from '../shared/domain/types'
import PeersPanel from './PeersPanel'
import FileList from './FileList'
import ThemeToggle from './ThemeToggle'
import LanguageSelector from './LanguageSelector'
import { useTranslation } from '../i18n'

type RoomActions = {
  sendFiles(files: File[], expiry: ExpiryConfig | null): Promise<void>
  deleteFile(id: string): void
  downloadFile(id: string): void
  kickPeer(): void
  banPeer(duration: number | null): void
  leaveRoom(): void
}

export default function Room({
  state,
  actions,
  theme,
  onToggleTheme,
}: {
  state: AppState
  actions: RoomActions
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}) {
  const { t } = useTranslation()
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

  const connectionTypeLabel =
    state.connectionType === 'turn'
      ? '(TURN)'
      : state.connectionType === 'direct'
        ? '(P2P directo)'
        : ''

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

  const statusLabel =
    t.room.status[state.connectionStatus as keyof typeof t.room.status] ?? ''

  return (
    <>
      <header className="room-header">
        <h1 className="logo-small">fAir Drop</h1>
        <div className="room-info" aria-label={t.room.ariaRoomCode}>
          <span className="room-code">{state.roomCode}</span>
          <button className="btn-icon" type="button" aria-label={t.room.ariaCopyCode} onClick={copyCode}>
            {copiedCode ? t.room.copied : t.room.copy}
          </button>
          <button
            className="btn btn-destructive"
            type="button"
            aria-label={t.room.ariaLeave}
            onClick={() => {
              const isMobile =
                matchMedia('(pointer: coarse)').matches ||
                /mobile|android|iphone|ipad/i.test(navigator.userAgent)
              if (isMobile) {
                const ok = window.confirm(t.room.leaveConfirmMobile)
                if (ok) actions.leaveRoom()
              } else {
                setShowExitModal(true)
              }
            }}
          >
            {t.room.leave}
          </button>
        </div>
        <div className={`status status-${state.connectionStatus}`} role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <span>{statusLabel}{connectionTypeLabel ? ` ${connectionTypeLabel}` : ''}</span>
        </div>
        <LanguageSelector inline />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} inline />
        {state.roomError ? (
          <p className="error-msg" role="status" aria-live="polite">
            {state.roomError}
          </p>
        ) : null}
      </header>

      {showExitModal ? (
        <div className="confirm-backdrop" role="dialog" aria-modal="true">
          <div className="confirm-modal">
            <h3>{t.room.leaveTitle}</h3>
            <p>{t.room.leaveConfirm}</p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setShowExitModal(false)}>
                {t.room.cancel}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setShowExitModal(false)
                  actions.leaveRoom()
                }}
              >
                {t.room.leave}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {state.connectionStatus === 'relay' ? (
        <div className="relay-warning" role="status" aria-live="polite">
          <strong>⚠️</strong> {t.room.relayWarning} (vía servidor)
        </div>
      ) : null}

      {state.isCreator && state.shareUrl ? (
        <aside className="share-banner" aria-label={t.room.shareLabel}>
          <p className="share-label">{t.room.shareLabel}</p>
          <div className="share-row">
            <span className="share-url">{state.shareUrl}</span>
            <button className="btn btn-secondary" type="button" onClick={copyLink}>
              {copiedLink ? t.room.copied : t.room.copyLink}
            </button>
            <button className="btn btn-secondary" type="button" onClick={nativeShare}>
              {t.room.share}
            </button>
          </div>
        </aside>
      ) : null}

      <div className="room-body">
        <section className="room-main" aria-label={t.room.filesTitle}>
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
                <span className="drop-icon" aria-hidden="true">...</span>
                <p className="drop-label">{t.room.waitingPeer}</p>
                <p className="drop-sub">{t.room.shareToConnect}</p>
              </div>
            ) : (
              <div className="drop-content">
                <span className="drop-icon" aria-hidden="true">+</span>
                <p className="drop-label">{t.room.dropFiles}</p>
                <p className="drop-sub">{t.room.dropClick}</p>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    fileInputRef.current?.click()
                  }}
                >
                  {t.room.selectFiles}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => void sendSelected(Array.from(e.target.files ?? []))}
                />

                <fieldset className="expiry-bar" onClick={(e) => e.stopPropagation()}>
                  <legend>{t.room.expiryOptions}</legend>
                  <label className="expiry-option">
                    <input
                      type="checkbox"
                      checked={expiry.timeEnabled}
                      onChange={(e) => setExpiry((x) => ({ ...x, timeEnabled: e.target.checked }))}
                    />
                    <span>{t.room.expiresIn}</span>
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
                    <span>{t.room.sec}</span>
                  </label>
                  <label className="expiry-option">
                    <input
                      type="checkbox"
                      checked={expiry.dlEnabled}
                      onChange={(e) => setExpiry((x) => ({ ...x, dlEnabled: e.target.checked }))}
                    />
                    <span>{t.room.max}</span>
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
                    <span>{t.room.downloads}</span>
                  </label>
                </fieldset>
              </div>
            )}
          </div>

          {hasFiles ? (
            <section className="file-list-section" aria-labelledby="files-title">
              <h2 id="files-title" className="section-title">
                {t.room.filesTitle}
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
            {t.room.connectionsTitle}
          </h2>
          <PeersPanel
            state={state}
            actions={{ kickPeer: actions.kickPeer, banPeer: actions.banPeer }}
          />
          {state.isCreator && state.shareUrl ? (
            <figure className="qr-card qr-card--sidebar">
              <img
                className="room-qr"
                alt="QR"
                src={`/api/qr?text=${encodeURIComponent(state.shareUrl)}`}
              />
              <figcaption>{t.room.scanQrPrompt}</figcaption>
            </figure>
          ) : null}
        </aside>
      </div>
    </>
  )
}
