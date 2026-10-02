const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const WebSocket = require('ws')

function receiveSession({ url, directory, code, maxBytes = 512 * 1024 * 1024 }) {
  fs.mkdirSync(directory, { recursive: true })
  const destination = fs.mkdtempSync(path.join(path.resolve(directory), 'session-'))
  const session = { state: 'connecting', received: [], directory: destination, error: null }
  let active = null
  const ws = new WebSocket(url)
  let timer
  const discard = () => {
    if (!active) return
    fs.closeSync(active.fd)
    fs.unlinkSync(active.partial)
    active = null
  }
  session.close = () => { clearTimeout(timer); discard(); ws.close(); session.state = 'closed' }
  session.ready = new Promise((resolve, reject) => {
    const fail = (err) => {
      session.error = err.message
      session.close()
      session.state = 'error'
      reject(err)
    }
    timer = setTimeout(() => fail(new Error('Sesión expirada')), 15 * 60 * 1000)
    ws.on('error', fail)
    ws.on('close', () => {
      clearTimeout(timer)
      discard()
      if (session.state !== 'error') session.state = 'closed'
      reject(new Error('Conexión cerrada antes de crear la sala'))
    })
    ws.on('open', () => ws.send(JSON.stringify(code ? { type: 'join-room', code } : { type: 'create-room' })))
    ws.on('message', (data, binary) => {
      try {
        if (binary) {
          if (!active) throw new Error('Chunk sin archivo activo')
          if (++active.chunks > active.totalChunks || active.bytes + data.length > active.size) throw new Error('Archivo supera los límites declarados')
          let offset = 0
          while (offset < data.length) offset += fs.writeSync(active.fd, data, offset, data.length - offset)
          active.bytes += data.length
          return
        }
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' || msg.type === 'kicked' || msg.type === 'banned') throw new Error(msg.message || msg.reason || msg.type)
        if (msg.type === 'room-created' || msg.type === 'room-joined') {
          session.code = msg.code
          session.state = 'waiting'
          if (code) ws.send(JSON.stringify({ type: 'relay-mode' }))
          resolve(session)
        }
        if (msg.type === 'peer-joined' || msg.type === 'offer') {
          ws.send(JSON.stringify({ type: 'relay-mode' }))
          session.state = 'ready'
        }
        if (msg.type === 'peer-disconnected') { discard(); session.state = 'waiting' }
        if (msg.type !== 'relay-meta') return
        const p = msg.payload
        if (p.type === 'file-start') {
          if (active) throw new Error('Transferencias simultáneas no soportadas')
          if (typeof p.name !== 'string' || p.name.includes('\0')) throw new Error('Nombre inválido')
          const name = path.basename(p.name.replace(/\\/g, '/'))
          if (!name || name === '.' || name === '..') throw new Error('Nombre inválido')
          if (typeof p.fileId !== 'string' || !Number.isSafeInteger(p.size) || p.size < 0 || p.size > maxBytes || !Number.isSafeInteger(p.totalChunks) || p.totalChunks < 0 || p.totalChunks > Math.max(1, p.size)) throw new Error('Metadatos inválidos')
          const target = path.join(destination, crypto.randomUUID() + '-' + name)
          const partial = target + '.part'
          active = { fd: fs.openSync(partial, 'wx', 0o600), partial, target, name, fileId: p.fileId, size: p.size, totalChunks: p.totalChunks, bytes: 0, chunks: 0 }
          session.state = 'receiving'
        }
        if (p.type === 'file-end') {
          if (!active || p.fileId !== active.fileId || active.bytes !== active.size || active.chunks !== active.totalChunks) throw new Error('Archivo incompleto')
          fs.closeSync(active.fd)
          fs.renameSync(active.partial, active.target)
          session.received.push({ name: active.name, path: active.target, size_bytes: active.bytes })
          active = null
          session.state = 'received'
        }
      } catch (err) { fail(err) }
    })
  })
  return session
}

module.exports = { receiveSession }

if (require.main === module) {
  const session = receiveSession({ url: process.env.FAIRDROP_URL || 'ws://127.0.0.1:3002/ws', directory: process.argv[2] || path.join(__dirname, '../received'), code: process.argv[3] })
  session.ready.then(() => console.log(JSON.stringify({ room_code: session.code, directory: session.directory }))).catch(err => { console.error(err.message); process.exitCode = 1 })
  const statusTimer = setInterval(() => {
    console.log(JSON.stringify({ state: session.state, received: session.received, error: session.error }))
    if (session.state === 'closed' || session.state === 'error') clearInterval(statusTimer)
  }, 3000)
}
