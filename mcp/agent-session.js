const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { z } = require('zod')
const { AgentTransport } = require('./agent-transport')
const { FileReceiver } = require('./file-receiver')
const { sendFileChunks, handleReceipt } = require('./sender')
const { maxFileBytes } = require('./transfer-config')

const id = z.string().uuid()
const descriptor = z.object({ name: z.string().min(1).max(240), size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()
const messageSchema = z.object({ type: z.literal('agent-message'), version: z.literal(1), message_id: id, kind: z.string().min(1).max(64), body: z.record(z.string(), z.unknown()), reply_to: id.optional(), attachments: z.array(descriptor).max(10) }).strict()
const helloSchema = z.object({ type: z.literal('agent-identity'), version: z.literal(1), conversation_id: id, endpoint_id: id, role: z.enum(['creator', 'guest']), alias: z.string().min(1).max(80), project: z.string().max(120).optional() }).strict()
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const terminal = new Set(['closed', 'error', 'expired', 'offline'])

function wireMessage(m) { return { type: 'agent-message', version: 1, message_id: m.message_id, kind: m.kind, body: m.body, ...(m.reply_to ? { reply_to: m.reply_to } : {}), attachments: m.attachments.map(({ name, size_bytes }) => ({ name, size_bytes })) } }

class AgentSession extends EventEmitter {
  constructor(store, options = {}) {
    super()
    this.store = store; this.id = store.meta.session_id
    this.state = store.meta.closed ? 'closed' : 'offline'; this.error = null; this.peer = store.meta.peer || null
    this.transport = new AgentTransport({ meta: { ...store.meta }, onCode: code => store.saveMeta({ code }), ...options })
    this.transport.on('state', state => { if (!terminal.has(this.state) || state === 'connecting' || state === 'reconnecting') { this.state = state; this.emit('update') } })
    this.transport.on('secure', () => {
      this.identityTimer = setTimeout(() => this.fail(new Error('Peer identity handshake timed out')), 10000)
      this.sendControl({ type: 'agent-identity', version: 1, conversation_id: store.meta.conversation_id, endpoint_id: store.meta.endpoint_id, role: store.meta.role, alias: store.meta.alias, ...(store.meta.project ? { project: store.meta.project } : {}) })
    })
    this.transport.on('frame', (type, data) => {
      try { if (type === 2) this.receiveChunk(data); else this.receive(JSON.parse(data.toString('utf8'))) }
      catch (err) { this.fail(err) }
    })
    this.transport.on('reset', () => { clearTimeout(this.identityTimer); this.discardIncoming(); if (this.tx) this.tx.error = 'Connection interrupted'; if (this.senderContext?.flow) this.senderContext.flow.error = 'Connection interrupted' })
    this.transport.on('failure', err => this.fail(err))
  }
  async open() {
    if (this.store.meta.closed) throw new Error('Session was explicitly closed; create a new conversation')
    if (Date.now() >= this.store.meta.expires_at) throw new Error('Session expired')
    this.store.claim()
    try { await this.transport.connect() }
    catch (err) { this.fail(err); throw err }
  }
  sendControl(msg) { this.transport.send(1, msg) }
  receive(p) {
    if (!p || typeof p !== 'object') throw new Error('Invalid agent message')
    if (p.type === 'agent-identity') {
      if (this.state === 'connected') throw new Error('Duplicate peer identity handshake')
      const peer = helloSchema.parse(p)
      if (peer.conversation_id !== this.store.meta.conversation_id || peer.role === this.store.meta.role || (this.peer && this.peer.endpoint_id !== peer.endpoint_id)) throw new Error('Peer identity does not match this conversation')
      this.peer = { endpoint_id: peer.endpoint_id, alias: peer.alias, project: peer.project }
      clearTimeout(this.identityTimer)
      this.store.saveMeta({ peer: this.peer })
      this.transport.setState('connected'); this.state = 'connected'; this.emit('update')
      // Replay durable receipts after reconnect/restart, including explicit reads.
      for (const m of this.store.inbox) this.receipt(m.message_id, m.read ? 'read' : 'delivered')
      this.pump()
      return
    }
    if (this.state !== 'connected') throw new Error('Application message before authenticated identity')
    if (p.type === 'agent-message') return this.beginIncoming(p)
    if (p.type === 'agent-message-end') {
      const current = this.incoming
      if (!current || p.message_id !== current.message.message_id || current.attachments.length !== current.message.attachments.length || this.receiver.active) throw new Error('Incomplete agent message')
      try {
        const m = this.store.commitIncoming({ ...current.message, from: this.peer, fingerprint: fingerprint(current.message), attachments: current.attachments })
        if (m.reply_to) {
          const original = this.store.outbox.find(item => item.message_id === m.reply_to)
          if (original) this.store.put('outbox', { ...original, state: 'replied', replied: true, replied_at: m.received_at })
        }
        this.discardIncoming(); this.receipt(m.message_id, 'delivered'); this.emit('update')
      } catch (err) { this.rejectIncoming(p.message_id, err) }
      return
    }
    if (p.type === 'agent-ready') { if (this.tx?.id === p.message_id) this.tx.ready = true; return }
    if (p.type === 'agent-receipt') {
      id.parse(p.message_id)
      if (!['delivered', 'read'].includes(p.state)) throw new Error('Invalid receipt state')
      const original = this.store.outbox.find(m => m.message_id === p.message_id)
      if (original) {
        const state = original.replied ? 'replied' : original.state === 'read' || p.state === 'read' ? 'read' : 'delivered'
        this.store.put('outbox', { ...original, state, error: null, delivered_at: original.delivered_at || new Date().toISOString(), ...(p.state === 'read' ? { read_at: original.read_at || new Date().toISOString() } : {}) })
      }
      if (this.tx?.id === p.message_id) this.tx.complete = true
      this.emit('update'); return
    }
    if (p.type === 'agent-error') { if (this.tx?.id === p.message_id) this.tx.error = String(p.message || 'Recipient rejected the message').slice(0, 300); return }
    if (p.type === 'agent-cancel') { if (this.incoming?.message.message_id === p.message_id) this.discardIncoming(); return }
    if (p.type === 'agent-close') { this.close(false).catch(err => this.fail(err)); return }
    if (['file-ready', 'file-ack', 'file-received', 'file-error'].includes(p.type)) {
      if (this.senderContext) handleReceipt(this.senderContext, p)
      if (p.type !== 'file-error') return
      if (!this.incoming || this.receiver?.active?.fileId !== p.fileId) return
    }
    if (['file-start', 'file-end', 'file-error'].includes(p.type)) {
      try { if (!this.receiver) throw new Error('File without an active message'); this.receiver.meta(p) }
      catch (err) { if (p.fileId) this.sendControl({ type: 'file-error', fileId: p.fileId, message: 'Attachment rejected' }); this.rejectIncoming(this.incoming?.message.message_id, err) }
      return
    }
    throw new Error('Unsupported agent message type')
  }
  beginIncoming(payload) {
    const m = messageSchema.parse(payload)
    if (Buffer.byteLength(JSON.stringify(m.body)) > 64 * 1024) throw new Error('Message exceeds 64 KiB')
    const existing = this.store.inbox.find(item => item.message_id === m.message_id)
    if (existing) {
      if (existing.fingerprint !== fingerprint(m)) throw new Error('Message ID reused for different content')
      this.receipt(m.message_id, existing.read ? 'read' : 'delivered'); return
    }
    if (this.incoming) throw new Error('Simultaneous incoming messages are unsupported')
    try {
      for (const a of m.attachments) if (a.size_bytes > maxFileBytes() || path.basename(a.name.replace(/\\/g, '/')) !== a.name || a.name.includes('\0') || ['.', '..'].includes(a.name)) throw new Error('Invalid attachment metadata')
      this.store.checkQuota(Buffer.byteLength(JSON.stringify(m.body)), m.attachments.reduce((sum, a) => sum + a.size_bytes, 0))
      this.store.reservation = { textBytes: Buffer.byteLength(JSON.stringify(m.body)), attachmentBytes: m.attachments.reduce((sum, a) => sum + a.size_bytes, 0) }
      this.incoming = { message: m, directory: this.store.stage(), attachments: [] }
      this.receiver = new FileReceiver({
        directory: this.incoming.directory, send: p => this.sendControl(p),
        onStart: p => {
          const expected = this.incoming.message.attachments[this.incoming.attachments.length]
          if (!expected || p.name !== expected.name || p.size !== expected.size_bytes || p.flowControl !== true) throw new Error('Attachment does not match message')
        },
        onFile: a => this.incoming.attachments.push(a),
      })
      this.sendControl({ type: 'agent-ready', message_id: m.message_id })
    } catch (err) { this.rejectIncoming(m.message_id, err) }
  }
  receiveChunk(data) {
    try { if (!this.receiver) throw new Error('Chunk without active message'); this.receiver.chunk(data) }
    catch (err) { if (this.receiver?.active) this.sendControl({ type: 'file-error', fileId: this.receiver.active.fileId, message: 'Attachment rejected' }); this.rejectIncoming(this.incoming?.message.message_id, err) }
  }
  rejectIncoming(messageId, err) {
    this.discardIncoming()
    if (!messageId) throw err
    this.sendControl({ type: 'agent-error', message_id: messageId, message: err.message.startsWith('quota_exceeded') ? err.message : 'Message or attachment could not be stored' })
  }
  discardIncoming() {
    this.store.reservation = null
    this.receiver?.discard(); this.receiver = null
    if (this.incoming) fs.rmSync(this.incoming.directory, { recursive: true, force: true })
    this.incoming = null
  }
  receipt(messageId, state) { this.sendControl({ type: 'agent-receipt', message_id: messageId, state }) }
  enqueue({ message_id = crypto.randomUUID(), kind = 'message', format = 'text', text, data, filename, attachments = [], reply_to, delivery_timeout_s = 120 }) {
    if (terminal.has(this.state) && this.state !== 'offline') throw new Error('Session is closed')
    if (Date.now() >= this.store.meta.expires_at) throw new Error('Session expired')
    let body, generated
    if (reply_to && !this.store.inbox.some(m => m.message_id === reply_to)) throw new Error('reply_to must refer to a received message in this session')
    if (format === 'text') { if (typeof text !== 'string' || data !== undefined) throw new Error('Text format requires text; use json format for data'); body = { text } }
    else if (format === 'json') { if (data === undefined || text !== undefined) throw new Error('JSON format requires data'); body = { json: data } }
    else {
      if ((text === undefined) === (data === undefined)) throw new Error('File format requires either text or data')
      const content = text === undefined ? JSON.stringify(data, null, 2) : text
      if (Buffer.byteLength(content) > 8 * 1024 ** 2) throw new Error('Generated file exceeds 8 MiB; send an existing file path instead')
      generated = { name: filename || (text === undefined ? 'message.json' : 'message.txt'), content }
      body = { text: 'Attached ' + generated.name }
    }
    if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024) throw new Error('Message exceeds 64 KiB; use file format or an attachment')
    const files = attachments.map(file => {
      if (!path.isAbsolute(file)) throw new Error('Attachment paths must be absolute')
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > maxFileBytes()) throw new Error('Attachment is not a regular file or exceeds the size limit')
      fs.accessSync(file, fs.constants.R_OK)
      return { name: path.basename(file), path: file, size_bytes: stat.size, mtime_ms: stat.mtimeMs }
    })
    if (generated) files.unshift({ name: path.basename(generated.name.replace(/\\/g, '/')), size_bytes: Buffer.byteLength(generated.content) })
    const wire = messageSchema.parse(wireMessage({ message_id, kind, body, reply_to, attachments: files }))
    const hash = fingerprint(wire)
    const existing = this.store.outbox.find(m => m.message_id === message_id)
    if (existing) {
      if (existing.fingerprint !== hash) throw new Error('Message ID reused for different content')
      if (['failed', 'expired'].includes(existing.state)) this.store.put('outbox', { ...existing, state: 'pending', error: null, deadline: Date.now() + delivery_timeout_s * 1000 })
      this.pump(); return this.messageStatus(message_id)
    }
    this.store.checkQuota(Buffer.byteLength(JSON.stringify(body)), generated ? Buffer.byteLength(generated.content) : 0)
    if (generated) {
      files[0].path = this.store.generatedFile(generated.name, generated.content)
      files[0].mtime_ms = fs.statSync(files[0].path).mtimeMs
    }
    const record = { message_id, kind, body, reply_to, attachments: files, fingerprint: hash, state: 'pending', deadline: Date.now() + delivery_timeout_s * 1000, created_at: new Date().toISOString() }
    this.store.put('outbox', record)
    this.emit('update'); this.pump()
    return this.messageStatus(message_id)
  }
  pump() {
    if (this.sending || this.state !== 'connected') return
    this.sending = true
    this.flush().catch(err => this.fail(err)).finally(() => {
      this.sending = false
      if (this.state === 'connected' && this.store.outbox.some(m => m.state === 'pending')) this.pump()
    })
  }
  async flush() {
    for (const m of [...this.store.outbox]) {
      if (this.state !== 'connected') return
      if (m.state !== 'pending') continue
      if (Date.now() >= m.deadline) { this.store.put('outbox', { ...m, state: 'expired', error: 'Delivery deadline expired' }); continue }
      const wireId = this.transport.wireId
      this.tx = { id: m.message_id, ready: false, complete: false, error: null }
      const tx = this.tx
      const wait = async check => {
        while (!check()) {
          if (this.transport.wireId !== wireId || this.state !== 'connected') throw new Error('Connection interrupted')
          if (tx.error) throw new Error(tx.error)
          if (Date.now() >= m.deadline) throw new Error('Delivery deadline expired')
          await new Promise(r => setTimeout(r, 10))
        }
        if (tx.error) throw new Error(tx.error)
      }
      try {
        this.sendControl(wireMessage(m))
        await wait(() => tx.ready || tx.complete)
        if (!tx.complete) {
          const self = this
          const context = this.senderContext = { seq: 0, sent: [], usingDC: true, channel: {
            get open() { return self.state === 'connected' && self.transport.wireId === wireId && !tx.error && Date.now() < m.deadline },
            get bufferedAmount() { return self.transport.bufferedAmount },
            send: raw => this.sendControl(JSON.parse(raw)),
            sendBinary: data => this.transport.send(2, data),
          } }
          for (const file of m.attachments) {
            const stat = fs.statSync(file.path)
            if (stat.size !== file.size_bytes || stat.mtimeMs !== file.mtime_ms) throw new Error('Source attachment changed; send it under a new message ID')
            await sendFileChunks(context, file)
          }
          this.sendControl({ type: 'agent-message-end', message_id: m.message_id })
          await wait(() => tx.complete)
        }
      } catch (err) {
        if (this.transport.wireId !== wireId || this.state !== 'connected') return // retry same durable ID after reconnect
        this.sendControl({ type: 'agent-cancel', message_id: m.message_id })
        const current = this.store.outbox.find(item => item.message_id === m.message_id)
        if (current.state === 'pending') this.store.put('outbox', { ...current, state: Date.now() >= m.deadline ? 'expired' : 'failed', error: err.message })
      } finally { this.senderContext = null; this.tx = null; this.emit('update') }
    }
  }
  inbox({ cursor, limit = 10, unread_only = cursor === undefined } = {}) {
    const after = cursor === undefined ? 0 : Number(cursor)
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid inbox cursor')
    const selected = this.store.inbox.filter(m => m.sequence > after && (!unread_only || !m.read)).sort((a, b) => a.sequence - b.sequence)
    const messages = []; let bytes = 0
    for (const m of selected.slice(0, limit)) {
      const { fingerprint: _hash, type: _type, version: _version, ...result } = m
      const size = Buffer.byteLength(JSON.stringify(result))
      if (messages.length && bytes + size > 128 * 1024) break
      messages.push(result); bytes += size
    }
    return { session_id: this.id, state: this.state, messages, next_cursor: String(messages.at(-1)?.sequence ?? after), has_more: selected.length > messages.length, error: this.error }
  }
  waitMessage(options = {}, signal) {
    const ready = () => { const result = this.inbox(options); return result.messages.length || terminal.has(this.state) ? result : null }
    const first = ready()
    if (signal?.aborted) return Promise.reject(new Error('Message wait cancelled'))
    if (first) return Promise.resolve({ ...first, timed_out: false })
    return new Promise((resolve, reject) => {
      const finish = (err, result) => { clearTimeout(timer); this.off('update', update); signal?.removeEventListener('abort', abort); err ? reject(err) : resolve(result) }
      const update = () => { const result = ready(); if (result) finish(null, { ...result, timed_out: false }) }
      const abort = () => finish(new Error('Message wait cancelled'))
      const timer = setTimeout(() => finish(null, { ...this.inbox(options), timed_out: true }), (options.timeout_s ?? 25) * 1000)
      this.on('update', update); signal?.addEventListener('abort', abort, { once: true }); update()
    })
  }
  ack(ids) {
    for (const messageId of ids) if (!this.store.inbox.some(m => m.message_id === messageId)) throw new Error('Unknown received message ID')
    for (const messageId of ids) {
      const m = this.store.inbox.find(item => item.message_id === messageId)
      if (!m.read) this.store.put('inbox', { ...m, read: true, read_at: new Date().toISOString() })
      if (this.state === 'connected') this.receipt(messageId, 'read')
    }
    this.emit('update'); return { session_id: this.id, acknowledged: ids }
  }
  messageStatus(messageId) {
    const m = this.store.outbox.find(item => item.message_id === messageId)
    if (!m) throw new Error('Unknown sent message ID')
    return { message_id: m.message_id, state: m.state, error: m.error || null, delivered_at: m.delivered_at, read_at: m.read_at, replied_at: m.replied_at }
  }
  status(messageId) {
    return { session_id: this.id, room_code: this.store.meta.code, state: this.state, transport: this.state === 'connected' ? this.transport.mode : null, encryption: 'TLSv1.3-PSK', peer: this.peer, unread: this.store.inbox.filter(m => !m.read).length, pending: this.store.outbox.filter(m => m.state === 'pending').length, expires_at: new Date(this.store.meta.expires_at).toISOString(), error: this.error, sent: messageId ? [this.messageStatus(messageId)] : this.store.outbox.slice(-20).map(m => this.messageStatus(m.message_id)) }
  }
  tick() {
    const now = Date.now()
    if (!this.store.locked && this.store.isLocked()) return
    for (const m of this.store.outbox) if (m.state === 'pending' && now >= m.deadline) { this.store.put('outbox', { ...m, state: 'expired', error: 'Delivery deadline expired' }); if (this.tx?.id === m.message_id) this.tx.error = 'Delivery deadline expired'; this.emit('update') }
    if (terminal.has(this.state)) return
    if (now >= this.store.meta.expires_at || (!this.peer && now - this.store.meta.created_at >= 15 * 60 * 1000)) { this.close(true, 'expired').catch(err => this.fail(err)); return }
    this.transport.tick()
  }
  async close(notify = true, state = 'closed') {
    if (notify && this.state === 'connected') { try { this.sendControl({ type: 'agent-close' }) } catch {} }
    this.state = state
    this.emit('update')
    // Let the encrypted close reach the peer before destroying the transport.
    const deadline = Date.now() + 1000
    while (notify && this.transport.bufferedAmount > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
    this.transport.stop({ closeRoom: notify })
    for (const m of this.store.outbox) if (m.state === 'pending') this.store.put('outbox', { ...m, state: state === 'expired' ? 'expired' : 'failed', error: 'Session closed before delivery' })
    this.store.saveMeta({ closed: true }); this.store.release(); this.closedAt = Date.now(); this.emit('update')
  }
  fail(err) {
    if (this.state === 'closed' || this.state === 'expired' || (this.state === 'error' && this.error)) return
    this.error = err.message; this.state = 'error'; this.transport.stop(); this.store.release(); this.closedAt = Date.now(); this.emit('update')
  }
  detach() { this.state = 'offline'; this.transport.stop(); this.store.release(); this.emit('update') }
}

module.exports = { AgentSession, wireMessage }
