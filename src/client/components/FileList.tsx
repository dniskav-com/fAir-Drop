import React, { useEffect, useState } from 'react'
import type { AppState } from '../app/state'
import { formatBytes } from '../shared/application/format'

export default function FileList({
  state,
  actions,
}: {
  state: AppState
  actions: { deleteFile(fileId: string): void; downloadFile(fileId: string): void }
}) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 600)
    return () => clearInterval(id)
  }, [])

  const incomingItems = Array.from(state.incoming.values()).map((entry) => {
    const meta = entry.meta
    const progress = meta.totalChunks ? Math.round((entry.received / meta.totalChunks) * 100) : 100
    const direction = entry.direction ?? 'receiving'
    return {
      id: meta.fileId,
      name: meta.name,
      size: meta.size,
      direction: direction as 'sending' | 'receiving',
      progress,
      expiry: state.fileExpiry.get(meta.fileId)?.remaining,
      downloadsLeft: state.fileExpiry.get(meta.fileId)?.downloadsLeft,
    }
  })

  const completed: Array<{
    id: string
    name: string
    url?: string
    size?: number
    expiry?: number
    downloadsLeft?: number
  }> = []
  const urls = new Set<string>()
  state.fileUrls.forEach((url: string, id: string) => {
    const meta = state.fileMeta.get(id)
    const expiry = state.fileExpiry.get(id)
    const entry: (typeof completed)[number] = { id, name: meta?.name ?? id, url }
    if (meta?.size !== undefined) entry.size = meta.size
    if (expiry?.remaining !== undefined) entry.expiry = expiry.remaining
    if (expiry?.downloadsLeft !== undefined) entry.downloadsLeft = expiry.downloadsLeft
    completed.push(entry)
    urls.add(id)
  })
  // include sent items that have metadata but no URL (sender-side completed)
  state.fileMeta.forEach((meta: { name: string; size?: number }, id: string) => {
    if (urls.has(id)) return
    if (state.incoming.has(id)) return
    const expiry = state.fileExpiry.get(id)
    const entry: (typeof completed)[number] = { id, name: meta.name }
    if (meta.size !== undefined) entry.size = meta.size
    if (expiry?.remaining !== undefined) entry.expiry = expiry.remaining
    if (expiry?.downloadsLeft !== undefined) entry.downloadsLeft = expiry.downloadsLeft
    completed.push(entry)
  })

  return (
    <ul className="file-list">
      {incomingItems.map((it) => (
        <li key={it.id} className="file-item">
          <div className="file-icon" dangerouslySetInnerHTML={{ __html: '' }} />
          <div className="file-meta">
            <div className="file-name">{it.name}</div>
            <div className="file-size">{it.size ? formatBytes(it.size) : `${it.progress}%`}</div>
            <div className="progress-wrap">
              <div className="progress-bar" style={{ width: `${it.progress}%` }} />
            </div>
          </div>
          <div className="file-actions">
            <span
              className={
                'badge ' + (it.direction === 'sending' ? 'badge-sending' : 'badge-receiving')
              }
            >
              {it.direction === 'sending' ? 'enviando' : 'recibiendo'}
            </span>
            {typeof it.expiry === 'number' ? (
              <span className="expiry-tag time">{it.expiry}s</span>
            ) : null}
            {typeof it.downloadsLeft === 'number' ? (
              <span className="expiry-tag dl">{it.downloadsLeft}</span>
            ) : null}
            <button
              className="btn-delete"
              onClick={() => actions.deleteFile(it.id)}
              data-delete-file={it.id}
            >
              Eliminar
            </button>
          </div>
        </li>
      ))}

      {completed.map((c) => (
        <li key={c.id} className="file-item">
          <div className="file-icon" dangerouslySetInnerHTML={{ __html: '' }} />
          <div className="file-meta">
            <div className="file-name">{c.name}</div>
            {c.size ? <div className="file-size">{formatBytes(c.size)}</div> : null}
          </div>
          <div className="file-actions">
            {c.url ? (
              <a
                className="btn-download"
                onClick={() => actions.downloadFile(c.id)}
                href={c.url}
                download={c.name}
              >
                Descargar
              </a>
            ) : (
              <span className="badge badge-done">enviado</span>
            )}
            {typeof c.expiry === 'number' ? (
              <span className="expiry-tag time">{c.expiry}s</span>
            ) : null}
            {typeof c.downloadsLeft === 'number' ? (
              <span className="expiry-tag dl">{c.downloadsLeft}</span>
            ) : null}
            <button
              className="btn-delete"
              onClick={() => actions.deleteFile(c.id)}
              data-delete-file={c.id}
            >
              Eliminar
            </button>
          </div>
        </li>
      ))}

      {incomingItems.length === 0 && completed.length === 0 ? (
        <li className="file-item client-empty">No hay archivos</li>
      ) : null}
    </ul>
  )
}
