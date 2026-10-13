const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')
const { maxFileBytes } = require('./transfer-config')
const { FileReceiver } = require('./file-receiver')

function receiveSession({ url, directory, code, maxBytes = maxFileBytes() }) {
  fs.mkdirSync(directory, { recursive: true })
  const destination = fs.mkdtempSync(path.join(path.resolve(directory), 'session-'))
  const session = { state: 'connecting', received: [], directory: destination, error: null }
  let isCreator = false // true si esta sesión creó la sala (el par responde offers)
  let channel = null // DataChannel WebRTC (node-datachannel), si hay P2P
  const ws = new WebSocket(url)
  let timer
  let fail
  const refreshTimer = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { fail(new Error('Sesión expirada por inactividad')); session.state = 'expired' }, 15 * 60 * 1000)
  }

  const sendReceipt = (msg) => {
    if (channel?.open) channel.send(JSON.stringify(msg))
    else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'relay-meta', payload: msg }))
  }

  const receiver = new FileReceiver({ directory: destination, maxBytes, send: sendReceipt, onActivity: refreshTimer,
    onStart: () => { session.state = 'receiving' },
    onFile: file => { session.received.push(file); session.state = 'received' },
  })
  const handleChunk = data => receiver.chunk(data)
  const handleMeta = p => receiver.meta(p)
  let fallbackTimer = null
  const tryRelay = () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'relay-mode' }))
  }
  // P2P nativo (node-datachannel). onOpen → listo para recibir por DC;
  // onFail → canal cerrado y fallback a relay WS.
  function startChannel(role) {
    try {
      const { initChannel } = require('./webrtc')
      channel = initChannel({
        role,
        onOpen: () => { session.state = 'ready' },
        onString: (str) => { try { handleMeta(JSON.parse(str)) } catch (err) { fail(err) } },
        onBinary: (data) => { try { handleChunk(data) } catch (err) { fail(err) } },
        onSend: (m) => ws.send(JSON.stringify(m)),
        onFail: () => {
          if (channel) channel.close()
          channel = null
          tryRelay()
        },
      })
    } catch {
      channel = null
      tryRelay()
    }
  }
  const discard = () => receiver.discard()
  session.close = () => {
    session.closedAt ??= Date.now()
    clearTimeout(timer)
    clearTimeout(fallbackTimer)
    if (channel) { channel.close(); channel = null }
    discard()
    ws.close()
    session.state = 'closed'
  }
  session.ready = new Promise((resolve, reject) => {
    fail = (err) => {
      if (receiver.active?.flowControl) { try { sendReceipt({ type: 'file-error', fileId: receiver.active.fileId, message: err.message }) } catch {} }
      session.error = err.message
      session.close()
      session.state = 'error'
      reject(err)
    }
    refreshTimer()
    ws.on('error', fail)
    ws.on('close', () => {
      session.closedAt ??= Date.now()
      clearTimeout(timer)
      clearTimeout(fallbackTimer)
      if (channel) { channel.close(); channel = null }
      discard()
      if (!['error', 'expired', 'received'].includes(session.state)) session.state = 'closed'
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
        if (msg.type === 'room-closed') {
          session.close()
          reject(new Error(msg.reason || 'El anfitrión cerró la sala'))
          return
        }
        if (msg.type === 'error' || msg.type === 'kicked' || msg.type === 'banned') throw new Error(msg.message || msg.reason || msg.type)
        if (msg.type === 'room-created' || msg.type === 'room-joined') {
          session.code = msg.code
          session.state = 'waiting'
          isCreator = msg.type === 'room-created'
          resolve(session)
          // Sin relay-mode anticipado: se espera la offer del creador (P2P).
          // Compat: si en 4 s no llega offer, caemos a relay (TUI/MCP viejos)
          clearTimeout(fallbackTimer)
          if (!isCreator) fallbackTimer = setTimeout(() => { if (!channel) tryRelay() }, 4000)
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
