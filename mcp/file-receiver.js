const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { maxFileBytes } = require('./transfer-config')
const { syncDirectory } = require('./agent-store')

// Shared disk streaming protocol, with at most one incoming file per direction.
class FileReceiver {
  constructor({ directory, send, onFile, onStart = () => {}, onActivity = () => {}, maxBytes = maxFileBytes() }) {
    Object.assign(this, { directory, send, onFile, onStart, onActivity, maxBytes })
    this.active = null
  }
  meta(p) {
    if (p.type === 'file-error' && this.active?.fileId === p.fileId) throw new Error(p.message || 'Sender cancelled transfer')
    if (p.type === 'file-start') {
      if (this.active) throw new Error('Simultaneous incoming files are unsupported')
      if (typeof p.name !== 'string' || p.name.includes('\0')) throw new Error('Invalid filename')
      const name = path.basename(p.name.replace(/\\/g, '/'))
      if (!name || ['.', '..'].includes(name)) throw new Error('Invalid filename')
      if (typeof p.fileId !== 'string' || p.fileId.length > 128 || !Number.isSafeInteger(p.size) || p.size < 0 || p.size > this.maxBytes || !Number.isSafeInteger(p.totalChunks) || p.totalChunks < 0 || (p.size > 0 && p.totalChunks === 0) || p.totalChunks > Math.max(1, p.size)) throw new Error('Invalid file metadata')
      this.onStart({ ...p, name })
      const target = path.join(this.directory, crypto.randomUUID() + '-' + name)
      const partial = target + '.part'
      this.active = { fd: fs.openSync(partial, 'wx', 0o600), partial, target, name, fileId: p.fileId, size: p.size, totalChunks: p.totalChunks, bytes: 0, chunks: 0, flowControl: p.flowControl === true }
      this.onActivity()
      if (this.active.flowControl) this.send({ type: 'file-ready', fileId: p.fileId })
    }
    if (p.type === 'file-end') {
      const a = this.active
      if (!a || p.fileId !== a.fileId || a.bytes !== a.size || a.chunks !== a.totalChunks) throw new Error('Incomplete file')
      fs.fsyncSync(a.fd)
      fs.closeSync(a.fd); a.fd = null
      fs.renameSync(a.partial, a.target)
      syncDirectory(this.directory)
      this.onFile({ name: a.name, path: a.target, size_bytes: a.bytes })
      this.active = null
      if (a.flowControl) this.send({ type: 'file-received', fileId: a.fileId })
    }
  }
  chunk(data) {
    const a = this.active
    if (!a) throw new Error('Chunk without an active file')
    if (data.length > 128 * 1024 || ++a.chunks > a.totalChunks || a.bytes + data.length > a.size) throw new Error('File exceeds declared limits')
    let offset = 0
    while (offset < data.length) {
      const written = fs.writeSync(a.fd, data, offset, data.length - offset)
      if (!written) throw new Error('Disk write stopped responding')
      offset += written
    }
    a.bytes += data.length
    this.onActivity()
    if (a.flowControl && (a.chunks % 8 === 0 || a.chunks === a.totalChunks)) this.send({ type: 'file-ack', fileId: a.fileId, received: a.chunks })
  }
  discard() {
    const a = this.active
    this.active = null
    if (!a) return
    if (a.fd != null) fs.closeSync(a.fd)
    try { fs.unlinkSync(a.partial) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
}
module.exports = { FileReceiver }
