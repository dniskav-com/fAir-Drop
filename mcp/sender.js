const fs = require('node:fs/promises')
const path = require('node:path')
const { maxFileBytes } = require('./transfer-config')
const CHUNK_SIZE = 128 * 1024
const WINDOW = 8

function handleReceipt(session, msg) {
  const flow = session.flow
  if (!flow || msg?.fileId !== flow.fileId) return
  if (msg.type === 'file-ready') flow.ready = true
  if (msg.type === 'file-ack' && Number.isSafeInteger(msg.received) && msg.received >= 0 && msg.received <= flow.totalChunks) flow.acked = Math.max(flow.acked, msg.received)
  if (msg.type === 'file-received') flow.complete = true
  if (msg.type === 'file-error') flow.error = String(msg.message || 'Recipient rejected the file')
}

async function sendFileChunks(session, file) {
  const channel = session.usingDC ? session.channel : null
  const ws = session.ws
  const flow = session.flow = { fileId: 'mcp-' + Date.now().toString(36) + '-' + (++session.seq), acked: 0, ready: false, complete: false }
  const ensureOpen = () => {
    if (flow.error) throw new Error(flow.error)
    if (channel ? !channel.open : !ws || ws.readyState !== 1) throw new Error('Transport closed during transfer')
  }
  const sendMeta = (meta) => {
    ensureOpen()
    if (channel) channel.send(JSON.stringify(meta))
    else ws.send(JSON.stringify({ type: 'relay-meta', payload: meta }))
  }
  async function waitUntil(check, timeout = 60000, optional = false) {
    let lastAck = flow.acked
    let deadline = Date.now() + timeout
    while (!check()) {
      ensureOpen()
      if (flow.acked !== lastAck) { lastAck = flow.acked; deadline = Date.now() + timeout }
      if (Date.now() >= deadline) {
        if (optional) return false
        throw new Error('Recipient or transport stopped responding')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    ensureOpen()
    return true
  }
  const handle = await fs.open(file.path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxFileBytes()) throw new Error('File is not regular or exceeds the configured size limit')
    const name = file.name || path.basename(file.path)
    const mimeMap = { apk: 'application/vnd.android.package-archive', aab: 'application/octet-stream', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', json: 'application/json', mp4: 'video/mp4' }
    flow.totalChunks = Math.ceil(stat.size / CHUNK_SIZE)
    sendMeta({ type: 'file-start', fileId: flow.fileId, name, size: stat.size, mimeType: mimeMap[name.split('.').pop().toLowerCase()] || 'application/octet-stream', totalChunks: flow.totalChunks, flowControl: true })
    // Older recipients ignore file-ready and remain supported.
    await waitUntil(() => flow.ready, stat.size > 64 * 1024 ** 2 ? 30000 : 2000, stat.size <= 64 * 1024 ** 2)
    let position = 0
    for (let i = 0; i < flow.totalChunks; i++) {
      if (flow.ready) await waitUntil(() => i - flow.acked < WINDOW)
      await waitUntil(() => (channel ? channel.bufferedAmount : ws.bufferedAmount) <= 1024 * 1024)
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, stat.size - position))
      let offset = 0
      while (offset < chunk.length) {
        const { bytesRead } = await handle.read(chunk, offset, chunk.length - offset, position + offset)
        if (!bytesRead) throw new Error('File changed or was truncated during transfer')
        offset += bytesRead
      }
      position += offset
      ensureOpen()
      if (channel) channel.sendBinary(chunk)
      else ws.send(chunk, { binary: true })
    }
    if (flow.ready) await waitUntil(() => flow.acked === flow.totalChunks)
    sendMeta({ type: 'file-end', fileId: flow.fileId })
    if (flow.ready) await waitUntil(() => flow.complete)
    else await waitUntil(() => (channel ? channel.bufferedAmount : ws.bufferedAmount) === 0)
    session.sent.push({ name, size_bytes: stat.size, chunks: flow.totalChunks, receiver_confirmed: flow.complete })
  } catch (err) {
    try { sendMeta({ type: 'file-error', fileId: flow.fileId, message: err.message }) } catch {}
    throw err
  } finally {
    await handle.close()
    session.flow = null
  }
}
module.exports = { sendFileChunks, handleReceipt }
