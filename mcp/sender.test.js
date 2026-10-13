const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { sendFileChunks, handleReceipt } = require('./sender')

test('streams a 1 GiB file with bounded fragments and receiver confirmation', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-large-'))
  const file = path.join(directory, 'large.apk')
  const size = 1024 ** 3
  fs.closeSync(fs.openSync(file, 'w'))
  fs.truncateSync(file, size)
  let bytes = 0, chunks = 0, maxChunk = 0
  const actual = crypto.createHash('sha256')
  const expected = crypto.createHash('sha256')
  const zero = Buffer.alloc(128 * 1024)
  for (let i = 0; i < size / zero.length; i++) expected.update(zero)
  const baseline = process.memoryUsage().arrayBuffers
  let peak = baseline
  const session = { seq: 0, sent: [], usingDC: true, channel: {
    open: true, bufferedAmount: 0,
    send(raw) {
      const meta = JSON.parse(raw)
      if (meta.type === 'file-start') {
        assert.equal(meta.size, size)
        assert.equal(meta.mimeType, 'application/vnd.android.package-archive')
        handleReceipt(session, { type: 'file-ready', fileId: meta.fileId })
      }
      if (meta.type === 'file-end') handleReceipt(session, { type: 'file-received', fileId: meta.fileId })
    },
    sendBinary(chunk) {
      actual.update(chunk)
      bytes += chunk.length
      maxChunk = Math.max(maxChunk, chunk.length)
      peak = Math.max(peak, process.memoryUsage().arrayBuffers)
      chunks++
      if (chunks % 8 === 0) handleReceipt(session, { type: 'file-ack', fileId: session.flow.fileId, received: chunks })
    },
  } }
  try {
    await sendFileChunks(session, { path: file })
    assert.equal(bytes, size)
    assert.ok(maxChunk <= 128 * 1024)
    assert.ok(peak - baseline < 128 * 1024 ** 2, `ArrayBuffers grew by ${peak - baseline}`)
    assert.equal(actual.digest('hex'), expected.digest('hex'))
    assert.equal(session.sent[0].receiver_confirmed, true)
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('propagates receiver storage errors without reading the entire file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-reject-'))
  const file = path.join(directory, 'small.bin')
  fs.writeFileSync(file, 'hello')
  const session = { seq: 0, sent: [], usingDC: true, channel: {
    open: true, bufferedAmount: 0,
    send(raw) { const msg = JSON.parse(raw); if (msg.type === 'file-start') handleReceipt(session, { type: 'file-error', fileId: msg.fileId, message: 'No disk space' }) },
    sendBinary() { assert.fail('No binary chunk should be sent after rejection') },
  } }
  try { await assert.rejects(sendFileChunks(session, { path: file }), /No disk space/); assert.equal(session.sent.length, 0) }
  finally { fs.rmSync(directory, { recursive: true }) }
})
