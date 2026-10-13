const tls = require('node:tls')
const { Duplex } = require('node:stream')

const MAX_FRAME = 128 * 1024
const OPTIONS = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256' }

// Standard TLS 1.3 external PSK over either WebSocket relay or WebRTC.
// The invitation is a random 256-bit key, never a password or room code.
function secureStream({ role, secret, write, onSecure, onFrame, onError }) {
  let secure = false, destroyed = false, buffer = Buffer.alloc(0)
  const wire = new Duplex({
    read() {},
    write(data, _encoding, callback) { Promise.resolve().then(() => write(data)).then(() => callback(), callback) },
  })
  let socket, server
  const report = err => { if (!destroyed) onError(err) }
  wire.on('error', report)
  if (role === 'creator') {
    server = tls.createServer({ ...OPTIONS, handshakeTimeout: 10000, pskCallback: (_socket, identity) => identity === 'fairdrop-agent-v1' ? secret : null })
    server.on('tlsClientError', report)
    server.on('secureConnection', connected => { socket = connected; install(connected); socket.disableRenegotiation(); secure = true; onSecure() })
    // No listening socket: TLS runs over the supplied local Duplex.
    server.emit('connection', wire)
  } else {
    socket = tls.connect({ ...OPTIONS, socket: wire, pskCallback: () => ({ identity: 'fairdrop-agent-v1', psk: secret }), checkServerIdentity: () => undefined }, () => { secure = true; onSecure() })
    install(socket)
  }
  function install(connection) {
    connection.on('error', report)
    connection.on('end', () => report(new Error('Encrypted stream ended')))
    connection.on('data', data => {
      try {
        buffer = Buffer.concat([buffer, data])
        while (buffer.length >= 5) {
          const type = buffer[0], size = buffer.readUInt32BE(1)
          if (![1, 2].includes(type) || size > MAX_FRAME || size < 1) throw new Error('Invalid encrypted frame')
          if (buffer.length < size + 5) break
          const payload = buffer.subarray(5, size + 5)
          buffer = buffer.subarray(size + 5)
          onFrame(type, payload)
        }
        if (buffer.length > MAX_FRAME + 5) throw new Error('Encrypted frame is too large')
      } catch (err) { report(err) }
    })
  }
  return {
    push(data) {
      if (destroyed) return
      if (data.length > 64 * 1024 || wire.readableLength + data.length > 1024 * 1024) throw new Error('Encrypted transport exceeds buffer limits')
      wire.push(data)
    },
    send(type, data) {
      if (!secure || destroyed || !socket) throw new Error('Encrypted stream is not connected')
      const payload = type === 1 ? Buffer.from(JSON.stringify(data)) : data
      if (!payload.length || payload.length > MAX_FRAME) throw new Error('Frame exceeds size limit')
      const header = Buffer.alloc(5); header[0] = type; header.writeUInt32BE(payload.length, 1)
      socket.write(Buffer.concat([header, payload]))
    },
    get bufferedAmount() { return (socket?.writableLength || 0) + wire.writableLength },
    close() { destroyed = true; socket?.destroy(); wire.destroy(); server?.close() },
  }
}
module.exports = { secureStream }
