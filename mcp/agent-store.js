const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function positiveLimit(value, fallback, label) {
  const limit = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(label + ' must be a positive safe integer')
  return limit
}
function assertId(id) { if (!UUID.test(id)) throw new Error('Invalid UUID') }
function privateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Storage directory must not be a symlink')
  fs.chmodSync(directory, 0o700)
}
function syncDirectory(directory) {
  let fd
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd) }
  catch (err) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(err.code)) throw err }
  finally { if (fd != null) fs.closeSync(fd) }
}
function atomicJSON(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try {
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) }
    finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file))
  }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}

class AgentStore {
  constructor({ root = process.env.FAIRDROP_AGENT_DIR || path.join(os.homedir(), '.local', 'share', 'fairdrop', 'agents'), projectDir = process.env.FAIRDROP_PROJECT_DIR || process.cwd(), maxMessages = process.env.FAIRDROP_AGENT_MAX_MESSAGES, maxTextBytes = process.env.FAIRDROP_AGENT_MAX_TEXT_BYTES, maxAttachmentBytes = process.env.FAIRDROP_AGENT_MAX_ATTACHMENT_BYTES } = {}) {
    this.scope = crypto.createHash('sha256').update(path.resolve(projectDir)).digest('hex')
    this.root = path.join(path.resolve(root), this.scope)
    this.limits = { maxMessages: positiveLimit(maxMessages, 1000, 'FAIRDROP_AGENT_MAX_MESSAGES'), maxTextBytes: positiveLimit(maxTextBytes, 64 * 1024 ** 2, 'FAIRDROP_AGENT_MAX_TEXT_BYTES'), maxAttachmentBytes: positiveLimit(maxAttachmentBytes, 16 * 1024 ** 3, 'FAIRDROP_AGENT_MAX_ATTACHMENT_BYTES') }
    privateDir(this.root)
  }
  directory(id) { assertId(id); return path.join(this.root, id) }
  create(config) {
    const id = crypto.randomUUID()
    const directory = this.directory(id)
    privateDir(directory)
    for (const dir of ['inbox', 'outbox', 'attachments', 'staging', 'generated']) privateDir(path.join(directory, dir))
    const meta = { ...config, session_id: id, endpoint_id: crypto.randomUUID(), created_at: Date.now(), updated_at: Date.now(), closed: false }
    atomicJSON(path.join(directory, 'session.json'), meta)
    return this.load(id)
  }
  load(id) {
    const directory = this.directory(id)
    const meta = JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8'))
    if (meta.session_id !== id) throw new Error('Invalid stored session')
    const readRecords = dir => fs.readdirSync(path.join(directory, dir)).filter(name => UUID.test(name.slice(0, -5)) && name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(directory, dir, name), 'utf8')))
    return new SessionStore(this, directory, meta, readRecords('inbox'), readRecords('outbox'))
  }
  list() {
    return fs.readdirSync(this.root).filter(id => UUID.test(id)).map(id => {
      const store = this.load(id)
      return { session_id: id, alias: store.meta.alias, project: store.meta.project, room_code: store.meta.code, state: store.meta.closed ? 'closed' : 'offline', unread: store.inbox.filter(m => !m.read).length, created_at: store.meta.created_at }
    })
  }
  prune(now = Date.now()) {
    for (const item of this.list()) {
      const store = this.load(item.session_id)
      if (store.isLocked()) continue
      if (!store.meta.closed && store.meta.expires_at <= now) {
        for (const m of store.outbox) if (m.state === 'pending') store.put('outbox', { ...m, state: 'expired', error: 'Session expired' })
        store.saveMeta({ closed: true })
      }
      if (!store.meta.closed || now - store.meta.updated_at < 24 * 60 * 60 * 1000 || store.inbox.some(m => !m.read) || store.outbox.some(m => m.state === 'pending')) continue
      fs.rmSync(store.directory, { recursive: true, force: true })
    }
  }
}

class SessionStore {
  constructor(owner, directory, meta, inbox, outbox) { Object.assign(this, { owner, directory, meta, inbox, outbox }); this.locked = false }
  isLocked() {
    try {
      const pid = Number(fs.readFileSync(path.join(this.directory, 'lock'), 'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid session lock')
      try { process.kill(pid, 0); return true } catch (err) { if (err.code === 'ESRCH') return false; return true }
    } catch (err) { if (err.code === 'ENOENT') return false; throw err }
  }
  claim() {
    const file = path.join(this.directory, 'lock')
    let fd
    try { fd = fs.openSync(file, 'wx', 0o600) }
    catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (this.isLocked()) throw new Error('Session is already open in another MCP process')
      fs.unlinkSync(file)
      fd = fs.openSync(file, 'wx', 0o600)
    }
    fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd)
    this.locked = true
    // Interrupted files are not complete messages; never expose them in inbox.
    for (const name of fs.readdirSync(path.join(this.directory, 'staging'))) fs.rmSync(path.join(this.directory, 'staging', name), { recursive: true, force: true })
    const referenced = new Set(this.inbox.flatMap(m => m.attachments.map(a => path.basename(a.path))))
    for (const name of fs.readdirSync(path.join(this.directory, 'attachments'))) if (!referenced.has(name)) fs.unlinkSync(path.join(this.directory, 'attachments', name))
  }
  release() { if (this.locked) { fs.unlinkSync(path.join(this.directory, 'lock')); this.locked = false } }
  saveMeta(patch = {}) { const next = { ...this.meta, ...patch, updated_at: Date.now() }; atomicJSON(path.join(this.directory, 'session.json'), next); this.meta = next }
  checkQuota(textBytes = 0, attachmentBytes = 0) {
    const records = [...this.inbox, ...this.outbox]
    if (records.length + (this.reservation ? 1 : 0) >= this.owner.limits.maxMessages || records.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m.body)), 0) + textBytes + (this.reservation?.textBytes || 0) > this.owner.limits.maxTextBytes) throw new Error('quota_exceeded: message history is full')
    const generatedRoot = path.join(this.directory, 'generated') + path.sep
    const used = this.inbox.reduce((n, m) => n + m.attachments.reduce((sum, a) => sum + a.size_bytes, 0), 0) + this.outbox.reduce((n, m) => n + m.attachments.filter(a => a.path?.startsWith(generatedRoot)).reduce((sum, a) => sum + a.size_bytes, 0), 0)
    if (used + attachmentBytes + (this.reservation?.attachmentBytes || 0) > this.owner.limits.maxAttachmentBytes) throw new Error('quota_exceeded: attachment storage is full')
  }
  put(direction, message) {
    assertId(message.message_id)
    const records = this[direction]
    atomicJSON(path.join(this.directory, direction, message.message_id + '.json'), message)
    const index = records.findIndex(m => m.message_id === message.message_id)
    if (index < 0) records.push(message)
    else records[index] = message
    this.saveMeta()
    return message
  }
  stage() { return fs.mkdtempSync(path.join(this.directory, 'staging', 'message-')) }
  commitIncoming(message) {
    const attachments = message.attachments.map(a => {
      const target = path.join(this.directory, 'attachments', path.basename(a.path))
      fs.renameSync(a.path, target)
      return { ...a, path: target }
    })
    syncDirectory(path.join(this.directory, 'attachments'))
    return this.put('inbox', { ...message, attachments, sequence: Math.max(0, ...this.inbox.map(m => m.sequence)) + 1, received_at: new Date().toISOString(), read: false })
  }
  generatedFile(name, content) {
    const safe = path.basename(name.replace(/\\/g, '/'))
    if (!safe || ['.', '..'].includes(safe) || safe.includes('\0')) throw new Error('Invalid attachment filename')
    const target = path.join(this.directory, 'generated', crypto.randomUUID() + '-' + safe)
    const fd = fs.openSync(target, 'wx', 0o600)
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    return target
  }
}

module.exports = { AgentStore, atomicJSON, assertId, syncDirectory }
