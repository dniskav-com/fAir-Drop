const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const WebSocket = require('ws')

function receiveSession({ url, directory, code, maxBytes = 512 * 1024 * 1024 }) {
  fs.mkdirSync(directory, { recursive: true })
  const destination = fs.mkdtempSync(path.join(path.resolve(directory), 'session-'))
  const session = { state: 'connecting', received: [], directory: destination, error: null }
  let active = null
  let isCreator = false // true si esta sesión creó la sala (el par responde offers)
  let channel = null // DataChannel WebRTC (node-datachannel), si hay P2P
  const ws = new WebSocket(url)
  let timer

  // Un solo handler para chunks, vengan de WS o del DataChannel
  const handleChunk = (data) => {
    if (!active) throw new Error('Chunk sin archivo activo')
    if (++active.chunks > active.totalChunks || active.bytes + data.length > active.size) throw new Error('Archivo supera los límites declarados')
    let offset = 0
    while (offset < data.length) offset += fs.writeSync(active.fd, data, offset, data.length - offset)
    active.bytes += data.length
  }
  // Meta sin envelope ('relay-meta' del WS o string JSON del DC)
  const handleMeta = (p) => {
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
  }
  let fallbackTimer = null
  const tryRelay = () => ws.send(JSON.stringify({ type: 'relay-mode' }))
  // P2P nativo (node-datachannel). onOpen → listo para recibir por DC;
  // onFail → canal cerrado y fallback a relay WS.
  function startChannel(role) {
    try {
      const { initChannel } = require('./webrtc')
      channel = initChannel({
        role,
        onOpen: () => { session.state = 'ready' },
        onString: (str) => { try { handleMeta(JSON.parse(str)) } catch (err) { fail(err) } },
        onBinary: handleChunk,
        onSend: (m) => ws.send(JSON.stringify(m)),
        onFail: () => { tryRelay() },
      })
    } catch {
      channel = null
      tryRelay()
    }
  }
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
          handleChunk(data)
          return
        }
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' || msg.type === 'kicked' || msg.type === 'banned') throw new Error(msg.message || msg.reason || msg.type)
        if (msg.type === 'room-created' || msg.type === 'room-joined') {
          session.code = msg.code
          session.state = 'waiting'
          isCreator = msg.type === 'room-created'
          resolve(session)
          // Sin relay-mode anticipado: se espera la offer del creador (P2P).
          // Compat: si en 4 s no llega offer, caemos a relay (TUI/MCP viejos)
          clearTimeout(fallbackTimer)
          fallbackTimer = setTimeout(() => { if (!channel || !channel.open) tryRelay() }, 4000)
        }
        if (msg.type === 'peer-joined' && isCreator) {
          clearTimeout(fallbackTimer)
          session.state = 'ready'
          if (!channel) startChannel('creator')
        }
        if (msg.type === 'offer') {
          clearTimeout(fallbackTimer)
          session.state = 'ready'
          if (!channel) startChannel('guest')
          if (channel) channel.onSignal(msg)
        }
        if (msg.type === 'answer' || msg.type === 'ice-candidate') {
          if (channel) channel.onSignal(msg)
        }
        if (msg.type === 'peer-disconnected') {
          if (channel) { channel.close(); channel = null }
          discard()
          session.state = 'waiting'
        }
        if (msg.type !== 'relay-meta') return
        handleMeta(msg.payload)
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
