import React, { useState, useCallback } from 'react'
import type { AppState } from '../app/state'
import { elapsed } from '../shared/application/format'
import { useTranslation } from '../i18n'

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function tokenize(text: string, format: string): string {
  const escaped = escapeHtml(text)

  switch (format) {
    case 'json': {
      return escaped
        .replace(
          /("(?:[^"\\]|\\.)*")\s*:/g,
          '<span class="key">$1</span>:',
        )
        .replace(
          /:\s*("(?:[^"\\]|\\.)*")/g,
          ': <span class="string">$1</span>',
        )
        .replace(
          /:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
          ': <span class="number">$1</span>',
        )
        .replace(
          /:\s*(true|false)/g,
          ': <span class="bool">$1</span>',
        )
        .replace(
          /:\s*(null)/g,
          ': <span class="null">$1</span>',
        )
    }
    case 'yaml': {
      return escaped
        .replace(
          /^(\s*)([\w.-]+)(\s*:)/gm,
          '$1<span class="key">$2</span>$3',
        )
        .replace(
          /:\s*(".*?")/g,
          ': <span class="string">$1</span>',
        )
        .replace(
          /:\s*(-?\d+(?:\.\d+)?)/g,
          ': <span class="number">$1</span>',
        )
    }
    case 'html':
    case 'xml': {
      return escaped
        .replace(
          /(&lt;\/?)([\w-]+)/g,
          '<span class="tag">$1$2</span>',
        )
        .replace(
          /([\w-]+)(=)/g,
          '<span class="attr-name">$1</span>$2',
        )
        .replace(
          /(=)(&quot;[^&]*?&quot;)/g,
          '$1<span class="attr-value">$2</span>',
        )
        .replace(
          /(&lt;!--.*?--&gt;)/g,
          '<span class="comment">$1</span>',
        )
    }
    case 'markdown': {
      return escaped
        .replace(
          /^(#{1,6}\s.*)$/gm,
          '<span class="heading">$1</span>',
        )
        .replace(
          /\*\*(.+?)\*\*/g,
          '<span class="bold">$1</span>',
        )
        .replace(
          /__(.+?)__/g,
          '<span class="bold">$1</span>',
        )
        .replace(
          /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
          '<span class="italic">$1</span>',
        )
        .replace(
          /(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
          '<span class="italic">$1</span>',
        )
        .replace(
          /`([^`]+)`/g,
          '<span class="code">$1</span>',
        )
        .replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          '<span class="link">[$1]($2)</span>',
        )
    }
    default:
      return escaped
  }
}

function InlineTextItem({
  entry,
  t,
}: {
  entry: import('../shared/domain/types').TextMessageEntry
  t: import('../i18n/types').Translations
}) {
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)
  const msgs = t.messages
  const { message, direction } = entry
  const isLong = message.content.length > 300

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [message.content])

  const store = (window as any).__fairdrop
  const handleDelete = useCallback(() => {
    store?.deleteText(message.id)
  }, [message.id, store])

  return (
    <li className="message-bubble">
      <div className="message-header">
        <span
          className={
            'badge ' + (direction === 'sending' ? 'badge-sending' : 'badge-receiving')
          }
        >
          {direction === 'sending' ? (msgs?.sent ?? 'sent') : (msgs?.received ?? 'received')}
        </span>
        <span className="format-badge" data-format={message.format}>
          {message.format}
        </span>
        <span className="message-time">{elapsed(message.timestamp)}</span>
      </div>
      <div className={`message-content${!expanded ? ' collapsed' : ''}`}>
        <pre>
          <code
            className={`syntax-${message.format}`}
            dangerouslySetInnerHTML={{
              __html: tokenize(message.content, message.format),
            }}
          />
        </pre>
      </div>
      {isLong && (
        <button
          className="btn btn-ghost btn-small"
          onClick={() => setExpanded((x) => !x)}
          style={{ marginBlockStart: 4 }}
        >
          {expanded ? (msgs?.collapse ?? 'Collapse') : (msgs?.expand ?? 'Expand')}
        </button>
      )}
      <div className="message-actions">
        <button
          className={`btn btn-icon btn-small message-copy-btn${copied ? ' copied' : ''}`}
          onClick={handleCopy}
        >
          {copied ? (msgs?.copied ?? 'Copied!') : (msgs?.copy ?? 'Copy')}
        </button>
        <button className="btn btn-icon btn-small btn-delete" onClick={handleDelete}>
          {msgs?.delete ?? 'Delete'}
        </button>
      </div>
    </li>
  )
}

export default function InlineTextList({
  state,
}: {
  state: AppState
}) {
  const { t } = useTranslation()
  const msgs = t.messages
  const entries = Array.from(state.textMessages.values())

  if (entries.length === 0) return null

  return (
    <ul className="file-list">
      {entries.map((entry) => (
        <InlineTextItem key={entry.message.id} entry={entry} t={t} />
      ))}
    </ul>
  )
}
