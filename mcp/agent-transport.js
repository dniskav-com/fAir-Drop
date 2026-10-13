const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const WebSocket = require('ws')
const { secureStream } = require('./agent-secure-stream')

class AgentTransport extends EventEmitter {
  constructor({ meta, onCode, relayOnly = process.env.FAIRDROP_AGENT_RELAY_ONLY === '1', handshakeMs = 15000, reconnectMs = 120000 }) {
    super()
    Object.assign(this, { meta, onCode, relayOnly, handshakeMs, reconnectMs })
    this.state = 'offline'; this.mode = null; this.stopped = false; this.channel = null; this.secure = null
    this.nativeAvailable = false
    if (!relayOnly) { try { this.initChannel = require('./webrtc').initChannel; this.nativeAvailable = true } catch {} }
  }
  setState(state) { this.state = state; this.emit('state', state) }
  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this.stopped = false
    this.setState(this.meta.code ? 'reconnecting' : 'connecting')
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(this.meta.url, { maxPayload: 256 * 1024, handshakeTimeout: 10000 })
      let settled = false
      const finish = err => { if (settled) return; settled = true; clearTimeout(roomTimer); err ? reject(err) : resolve() }
      const roomTimer = setTimeout(() => { finish(new Error('Timed out opening room')); ws.terminate() }, 12000)
      ws.on('open', () => ws.send(JSON.stringify(this.meta.code ? { type: this.meta.role === 'creator' ? 'reclaim-room' : 'join-room', code: this.meta.code } : { type: 'create-room' })))
      ws.on('message', (raw, binary) => {
        if (ws !== this.ws || this.stopped) return
        try {
          if (binary) throw new Error('unsupported_peer: unencrypted file protocol')
          const msg = JSON.parse(raw.toString())
          if (!msg || typeof msg !== 'object') throw new Error('Invalid signaling message')
          if (['room-created', 'room-reclaimed', 'room-joined'].includes(msg.type)) {
            if (!/^[A-Z0-9]{4}$/.test(msg.code)) throw new Error('Invalid room code')
            this.meta.code = msg.code; this.onCode(msg.code); this.setState('waiting_peer'); finish()
            if (this.meta.role === 'guest') this.announce()
          } else if (msg.type === 'peer-joined') {
            this.resetPeer(); this.announce()
          } else if (msg.type === 'peer-disconnected') {
            if (['authenticating', 'secure'].includes(this.state)) { this.fatal(new Error('authentication_failed: peer disconnected during authentication')); return }
            this.disconnectedAt ||= Date.now(); this.resetPeer(); this.setState('reconnecting')
          } else if (['room-closed', 'kicked', 'banned', 'error'].includes(msg.type)) {
            const err = new Error(msg.reason || msg.message || msg.type)
            finish(err); this.fatal(err)
          } else if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
            if (!this.peerHello) throw new Error('unsupported_peer: peer does not support agent messaging')
            this.channel?.onSignal(msg)
          } else if (msg.type === 'relay-mode') {
            if (this.meta.role === 'creator' && this.mode !== 'relay') this.selectRelay()
          } else if (msg.type === 'relay-meta') this.control(msg.payload)
        } catch (err) { finish(err); this.fatal(err) }
      })
      ws.on('error', err => { finish(err); if (ws === this.ws && !this.stopped) this.emit('networkError', err) })
      ws.on('close', () => {
        finish(new Error('Signaling connection closed'))
        if (ws !== this.ws || this.stopped) return
        this.disconnectedAt ||= Date.now(); this.resetPeer(); this.setState('reconnecting')
        this.retryTimer = setTimeout(() => {
          if (this.stopped) return
          this.connect().catch(() => {})
        }, 500)
      })
    })
  }
  signal(msg) { if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Signaling connection is closed'); this.ws.send(JSON.stringify(msg)) }
  announce() {
    this.ownHello ||= { type: 'agent-hello', version: 1, nonce: crypto.randomUUID(), transports: this.nativeAvailable ? ['p2p', 'relay'] : ['relay'] }
    this.signal({ type: 'relay-meta', payload: this.ownHello })
    if (!this.peerHello && !this.helloTimer) this.helloTimer = setTimeout(() => this.fatal(new Error('unsupported_peer: no agent handshake received')), this.handshakeMs)
  }
  control(p) {
    if (!p || typeof p !== 'object') throw new Error('Invalid agent envelope')
    if (p.type === 'agent-hello') {
      if (p.version !== 1 || typeof p.nonce !== 'string' || p.nonce.length !== 36 || !Array.isArray(p.transports) || !p.transports.includes('relay')) throw new Error('unsupported_peer: incompatible agent protocol')
      const duplicate = this.peerHello?.nonce === p.nonce
      if (!duplicate && this.peerHello) this.resetPeer()
      this.peerHello = p
      clearTimeout(this.helloTimer); this.helloTimer = null
      if (!this.ownHello) this.announce()
      if (duplicate || this.negotiating) return
      this.negotiating = true; this.setState('authenticating')
      this.authTimer = setTimeout(() => this.fatal(new Error('Agent authentication timed out')), this.handshakeMs + 8000)
      if (this.nativeAvailable && p.transports.includes('p2p')) this.startNative()
      else if (this.meta.role === 'creator') this.selectRelay()
    } else if (p.type === 'agent-transport') {
      if (this.meta.role !== 'guest' || !this.peerHello || !['p2p', 'relay'].includes(p.mode) || typeof p.wire_id !== 'string' || p.wire_id.length !== 36) throw new Error('Invalid agent transport selection')
      if (p.wire_id === this.wireId) return
      this.resetSecure(); this.mode = p.mode; this.wireId = p.wire_id
      if (p.mode === 'relay') { this.closeNative(); this.startSecure() }
      else if (this.channel?.open) this.startSecure()
    } else if (p.type === 'agent-wire') {
      if (p.wire_id !== this.wireId) return // late frames from a previous connection
      if (this.mode !== 'relay' || !this.secure || typeof p.data !== 'string' || p.data.length > 87384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)) throw new Error('Invalid encrypted transport data')
      this.secure.push(Buffer.from(p.data, 'base64'))
    } else throw new Error('unsupported_peer: peer is using a different protocol')
  }
  startNative() {
    const generation = this.ownHello.nonce
    try {
      this.channel = this.initChannel({
        role: this.meta.role,
        onSend: msg => { if (!this.stopped && generation === this.ownHello?.nonce) this.signal(msg) },
        onOpen: () => {
          if (generation !== this.ownHello?.nonce || this.stopped) return
          if (this.meta.role === 'creator') this.select('p2p')
          else if (this.mode === 'p2p') this.startSecure()
        },
        onString: () => this.fatal(new Error('Unencrypted data on agent channel')),
        onBinary: data => {
          if (generation !== this.ownHello?.nonce || this.mode !== 'p2p') return
          try { if (!this.secure) throw new Error('Encrypted stream is not ready'); this.secure.push(data) } catch (err) { this.fatal(err) }
        },
        onFail: () => {
          if (generation !== this.ownHello?.nonce || this.stopped) return
          if (this.meta.role === 'creator') this.selectRelay()
          else { this.closeNative(); this.signal({ type: 'relay-mode' }) }
        },
      })
    } catch {
      if (this.meta.role === 'creator') this.selectRelay()
      else this.signal({ type: 'relay-mode' })
    }
  }
  selectRelay() { this.closeNative(); this.select('relay') }
  select(mode) {
    if (this.stopped || !this.peerHello) return
    this.resetSecure(); this.mode = mode; this.wireId = crypto.randomUUID()
    this.signal({ type: 'relay-meta', payload: { type: 'agent-transport', mode, wire_id: this.wireId } })
    this.startSecure()
  }
  startSecure() {
    if (this.secure || this.stopped) return
    this.setState('authenticating')
    const wireId = this.wireId
    const stream = secureStream({
      role: this.meta.role, secret: Buffer.from(this.meta.secret, 'base64url'),
      write: async data => {
        for (let offset = 0; offset < data.length; offset += 16 * 1024) {
          if (this.stopped || this.wireId !== wireId) throw new Error('Transport changed')
          const chunk = data.subarray(offset, offset + 16 * 1024)
          if (this.mode === 'p2p') {
            const deadline = Date.now() + 30000
            while (this.channel?.open && this.channel.bufferedAmount > 1024 * 1024) {
              if (Date.now() >= deadline || this.wireId !== wireId) throw new Error('Transport stopped responding')
              await new Promise(r => setTimeout(r, 10))
            }
            if (!this.channel?.open) throw new Error('P2P channel closed')
            this.channel.sendBinary(chunk)
          } else {
            if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Relay connection closed')
            await new Promise((resolve, reject) => this.ws.send(JSON.stringify({ type: 'relay-meta', payload: { type: 'agent-wire', wire_id: wireId, data: chunk.toString('base64') } }), err => err ? reject(err) : resolve()))
          }
        }
      },
      onSecure: () => { if (this.wireId !== wireId) return; clearTimeout(this.authTimer); this.disconnectedAt = null; this.setState('secure'); this.emit('secure') },
      onFrame: (type, data) => { if (this.wireId === wireId) this.emit('frame', type, data) },
      onError: () => {
        if (this.stopped || this.wireId !== wireId) return
        if (this.state === 'connected' && this.ws?.readyState !== WebSocket.OPEN) {
          this.disconnectedAt ||= Date.now(); this.resetPeer(); this.setState('reconnecting'); return
        }
        this.fatal(new Error('authentication_failed: encrypted connection rejected or interrupted'))
      },
    })
    this.secure = stream
  }
  send(type, payload) { if (!this.secure) throw new Error('Agent transport is not connected'); this.secure.send(type, payload) }
  get bufferedAmount() { return (this.secure?.bufferedAmount || 0) + (this.ws?.bufferedAmount || 0) + (this.channel?.bufferedAmount || 0) }
  resetSecure() { const stream = this.secure; this.secure = null; this.wireId = null; stream?.close(); this.emit('reset') }
  closeNative() { const channel = this.channel; this.channel = null; channel?.close() }
  resetPeer() { clearTimeout(this.helloTimer); clearTimeout(this.authTimer); this.helloTimer = null; this.resetSecure(); this.closeNative(); this.ownHello = null; this.peerHello = null; this.negotiating = false; this.mode = null }
  tick() { if (this.disconnectedAt && Date.now() - this.disconnectedAt > this.reconnectMs) this.fatal(new Error('Peer reconnect deadline expired')) }
  fatal(err) { if (this.stopped) return; this.stop(); this.setState('error'); this.emit('failure', err) }
  stop({ closeRoom = false } = {}) {
    this.stopped = true; clearTimeout(this.retryTimer)
    if (closeRoom && this.meta.role === 'creator' && this.ws?.readyState === WebSocket.OPEN) this.signal({ type: 'close-room' })
    this.resetPeer()
    this.ws?.close(); this.ws = null
  }
}

module.exports = { AgentTransport }
