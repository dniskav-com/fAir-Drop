import React, { useState, useMemo } from 'react'
import { useTranslation } from '../i18n'

function detectFormat(text: string): string {
  if (/^\s*[\[{]/.test(text)) return 'json'
  if (/^\s*---/.test(text)) return 'yaml'
  if (/^\s*<[a-z]/i.test(text)) return 'html'
  return 'plain'
}

export default function TextPasteModal({
  text,
  onSendAsFile,
  onSendAsInline,
  onClose,
}: {
  text: string
  onSendAsFile: (text: string) => void
  onSendAsInline: (format: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const defaultFormat = useMemo(() => detectFormat(text), [text])
  const [selectedFormat, setSelectedFormat] = useState(defaultFormat)

  const preview = text.length > 200 ? text.slice(0, 200) + '...' : text
  const msgs = t.messages

  return (
    <div
      className="confirm-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="confirm-modal" style={{ maxWidth: 480 }}>
        <h3>{msgs?.preview ?? 'Preview'}</h3>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: '0.8125rem',
            lineHeight: 1.5,
            fontFamily: 'var(--font-mono, monospace)',
            maxHeight: 160,
            overflow: 'auto',
            padding: '8px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--panel-tint)',
            border: '1px solid var(--line)',
            marginBlock: '8px',
          }}
        >
          {preview}
        </pre>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: '0.8125rem',
            marginBlockEnd: 12,
          }}
        >
          <span style={{ fontWeight: 600 }}>{msgs?.format ?? 'Format'}:</span>
          <select
            value={selectedFormat}
            onChange={(e) => setSelectedFormat(e.target.value)}
            style={{
              padding: '4px 8px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--line)',
              background: 'var(--panel-solid)',
              color: 'var(--ink)',
              fontFamily: 'var(--font)',
              fontSize: '0.8125rem',
            }}
          >
            <option value="plain">plain</option>
            <option value="json">json</option>
            <option value="yaml">yaml</option>
            <option value="html">html</option>
            <option value="xml">xml</option>
            <option value="markdown">markdown</option>
          </select>
        </label>
        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            {t.room.cancel}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => onSendAsFile(text)}
          >
            {msgs?.sendAsFile ?? 'Send as .txt'}
          </button>
          <button className="btn btn-primary" onClick={() => onSendAsInline(selectedFormat)}>
            {msgs?.sendAsInline ?? 'Send as inline'}
          </button>
        </div>
      </div>
    </div>
  )
}
