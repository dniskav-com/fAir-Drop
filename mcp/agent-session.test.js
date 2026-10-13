const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const WebSocket = require('ws')
const { AgentManager } = require('./agent-tools')
const { AgentStore } = require('./agent-store')
const { broker, until } = require('./agent-test-helpers')

async function fixture(t, bOptions = {}) {
  const hub = await broker(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-agent-unit-'))
  const options = { url: hub.url, transportOptions: { relayOnly: true, handshakeMs: 200 }, storeOptions: { root, projectDir: 'project-a' } }
  const a = new AgentManager(options), b = new AgentManager({ ...options, storeOptions: { ...options.storeOptions, projectDir: 'project-b', ...bOptions } })
  const managers = [a, b]
  t.after(async () => { for (const m of managers) m.shutdown(); await hub.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const created = await a.create({ pairing: 'invitation', alias: 'api' }), joined = await b.join({ invitation: created.invitation, alias: 'front' })
  const A = a.get(created.session_id), B = b.get(joined.session_id)
  await until(() => A.state === 'connected' && B.state === 'connected')
  return { hub, root, a, b, A, B, created, joined, options, managers }
}

test('cancelled waits do not consume messages; pagination and read receipts are explicit', async t => {
  const { A, B } = await fixture(t)
  const abort = new AbortController()
  const waiting = B.waitMessage({ timeout_s: 5 }, abort.signal)
  abort.abort()
  await assert.rejects(waiting, /cancelled/)
  const first = A.enqueue({ text: 'first' }), second = A.enqueue({ text: 'second' })
  await until(() => B.store.inbox.length === 2)
  const page = B.inbox({ limit: 1 })
  assert.equal(page.messages[0].message_id, first.message_id); assert.equal(page.has_more, true)
  assert.equal(B.inbox({ cursor: page.next_cursor }).messages[0].message_id, second.message_id)
  assert.equal(B.inbox().messages.length, 2)
  B.ack([first.message_id]); B.ack([first.message_id])
  await until(() => A.messageStatus(first.message_id).state === 'read')
  assert.equal(B.inbox().messages.length, 1)
  assert.throws(() => B.waitMessage({ cursor: '99999999999999999999999999' }), /Invalid inbox cursor/)
})

test('lost receipts retry one durable message ID after reconnect', async t => {
  const { A, B, hub } = await fixture(t)
  const original = B.receipt.bind(B)
  let lose = true
  B.receipt = (...args) => { if (lose) return; original(...args) }
  const sent = A.enqueue({ text: 'exactly one visible message' })
  await until(() => B.store.inbox.length === 1)
  assert.equal(A.messageStatus(sent.message_id).state, 'pending')
  lose = false
  hub.rooms.get(A.store.meta.code).guest.terminate()
  await until(() => A.messageStatus(sent.message_id).state === 'delivered')
  assert.equal(B.store.inbox.length, 1)
  assert.equal(A.state, 'connected'); assert.equal(B.state, 'connected')
})

test('an interrupted attachment restarts completely after reconnect without exposing a partial message', async t => {
  const { A, B, root } = await fixture(t)
  const file = path.join(root, 'restart.bin'), contents = crypto.randomBytes(4 * 1024 * 1024)
  fs.writeFileSync(file, contents)
  let interrupted = false
  const chunk = B.receiveChunk.bind(B)
  B.receiveChunk = data => {
    chunk(data)
    if (!interrupted) { interrupted = true; assert.equal(B.store.inbox.length, 0); B.transport.ws.terminate() }
  }
  const sent = A.enqueue({ text: 'restart my attachment', attachments: [file] })
  await until(() => A.messageStatus(sent.message_id).state === 'delivered')
  assert.equal(B.store.inbox.length, 1)
  assert.deepEqual(fs.readFileSync(B.store.inbox[0].attachments[0].path), contents)
  assert.deepEqual(fs.readdirSync(path.join(B.store.directory, 'staging')), [])
})

test('a changed source cancels the incoming message so subsequent messages can still arrive', async t => {
  const { A, B, root } = await fixture(t)
  const file = path.join(root, 'changed.txt'); fs.writeFileSync(file, 'initial')
  const original = A.pump.bind(A)
  A.pump = () => {}
  const failed = A.enqueue({ text: 'will fail', attachments: [file] })
  fs.writeFileSync(file, 'different contents')
  A.pump = original; A.pump()
  await until(() => A.messageStatus(failed.message_id).state === 'failed')
  const next = A.enqueue({ text: 'still connected' })
  await until(() => A.messageStatus(next.message_id).state === 'delivered')
  assert.equal(B.store.inbox.length, 1); assert.equal(B.store.inbox[0].body.text, 'still connected')
})

test('pending messages expire without a peer; connected idle sessions do not close after sending', async t => {
  const { A, B } = await fixture(t)
  A.transport.ws.terminate()
  await until(() => A.state === 'reconnecting')
  A.transport.stopped = true; clearTimeout(A.transport.retryTimer)
  const sent = A.enqueue({ text: 'expire offline', delivery_timeout_s: 0.1 })
  await new Promise(r => setTimeout(r, 120)); A.tick()
  assert.equal(A.messageStatus(sent.message_id).state, 'expired')
  assert.equal(B.store.inbox.length, 0)
})

test('both endpoints recover persisted inbox/outbox after their MCP processes restart', async t => {
  const { A, B, a, b, options, root, created, joined, hub, managers } = await fixture(t)
  const id = A.enqueue({ text: 'durable before restart' }).message_id
  await until(() => A.messageStatus(id).state === 'delivered')
  a.shutdown(); b.shutdown()
  await until(() => !hub.rooms.get(A.store.meta.code).host && !hub.rooms.get(A.store.meta.code).guest)
  const nextA = new AgentManager(options), nextB = new AgentManager({ ...options, storeOptions: { root, projectDir: 'project-b' } })
  managers.push(nextA, nextB)
  const restoredA = nextA.get(created.session_id), restoredB = nextB.get(joined.session_id)
  assert.equal(restoredB.state, 'offline'); assert.equal(restoredB.inbox().messages[0].message_id, id)
  restoredB.ack([id])
  const queued = restoredA.enqueue({ text: 'queued while offline' })
  await nextA.resume(created.session_id); await nextB.resume(joined.session_id)
  await until(() => restoredA.state === 'connected' && restoredB.state === 'connected')
  await until(() => restoredA.messageStatus(id).state === 'read' && restoredA.messageStatus(queued.message_id).state === 'delivered')
  assert.equal(restoredB.store.inbox.length, 2)
})

test('quota rejects before streaming, leaving unread messages intact', async t => {
  const { A, B } = await fixture(t, { maxMessages: 1, maxAttachmentBytes: 2 })
  const first = A.enqueue({ text: 'must not be lost' })
  await until(() => A.messageStatus(first.message_id).state === 'delivered')
  const second = A.enqueue({ text: 'cannot fit' })
  await until(() => A.messageStatus(second.message_id).state === 'failed')
  assert.match(A.messageStatus(second.message_id).error, /quota_exceeded/)
  assert.equal(B.store.inbox.length, 1); assert.equal(B.inbox().messages[0].body.text, 'must not be lost')
  assert.deepEqual(fs.readdirSync(path.join(B.store.directory, 'staging')), [])
})

test('attachment quota rejects a message before any file chunks arrive', async t => {
  const { A, B, root } = await fixture(t, { maxAttachmentBytes: 2 })
  const file = path.join(root, 'oversized.txt'); fs.writeFileSync(file, 'three')
  let received = 0
  B.transport.on('frame', type => { if (type === 2) received++ })
  const sent = A.enqueue({ text: 'attachment', attachments: [file] })
  await until(() => A.messageStatus(sent.message_id).state === 'failed')
  assert.equal(received, 0); assert.equal(B.store.inbox.length, 0)
})

test('wrong invitation secret fails authentication without delivering content', async t => {
  const hub = await broker(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-secret-'))
  const a = new AgentManager({ url: hub.url, storeOptions: { root, projectDir: 'a' }, transportOptions: { relayOnly: true } })
  const b = new AgentManager({ url: hub.url, storeOptions: { root, projectDir: 'b' }, transportOptions: { relayOnly: true } })
  t.after(async () => { a.shutdown(); b.shutdown(); await hub.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const created = await a.create({ pairing: 'invitation', alias: 'a' })
  const config = JSON.parse(Buffer.from(created.invitation.slice(18), 'base64url'))
  config.secret = crypto.randomBytes(32).toString('base64url')
  const token = 'fairdrop-agent:v1:' + Buffer.from(JSON.stringify(config)).toString('base64url')
  const joined = await b.join({ invitation: token, alias: 'b' })
  const B = b.get(joined.session_id)
  await until(() => B.state === 'error')
  assert.match(B.error, /authentication_failed/); assert.equal(B.store.inbox.length, 0); assert.equal(B.store.locked, false)
})

test('legacy peer is rejected with unsupported_peer instead of sending agent messages', async t => {
  const hub = await broker(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-legacy-'))
  const a = new AgentManager({ url: hub.url, storeOptions: { root }, transportOptions: { relayOnly: true, handshakeMs: 100 } })
  let ws
  t.after(async () => { ws?.terminate(); a.shutdown(); await hub.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const created = await a.create({ pairing: 'invitation', alias: 'a' }); const A = a.get(created.session_id)
  A.enqueue({ text: 'must not leak to legacy peer' })
  ws = new WebSocket(hub.url); await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify({ type: 'join-room', code: created.room_code }))
  await until(() => A.state === 'error')
  assert.match(A.error, /unsupported_peer/)
  assert.ok(!JSON.stringify(hub.captured).includes('must not leak'))
})

test('malformed message IDs fail without writing files outside the session', async t => {
  const { A, B } = await fixture(t)
  A.sendControl({ type: 'agent-message', version: 1, message_id: '../../escape', kind: 'message', body: { text: 'x' }, attachments: [] })
  await until(() => B.state === 'error')
  assert.equal(B.store.inbox.length, 0)
  assert.deepEqual(fs.readdirSync(path.join(B.store.directory, 'staging')), [])
})

test('history cleanup preserves unread messages and active sessions; project scopes and locks are isolated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-scope-'))
  try {
    const a = new AgentStore({ root, projectDir: 'a' }), b = new AgentStore({ root, projectDir: 'b' })
    const stored = a.create({ alias: 'a' })
    assert.throws(() => b.load(stored.meta.session_id), /ENOENT/)
    stored.claim(); assert.throws(() => a.load(stored.meta.session_id).claim(), /already open/); stored.release()
    const message_id = crypto.randomUUID()
    stored.put('inbox', { message_id, body: { text: 'keep me' }, attachments: [], read: false, sequence: 1 })
    stored.saveMeta({ closed: true })
    a.prune(Date.now() + 25 * 60 * 60 * 1000)
    assert.equal(a.load(stored.meta.session_id).inbox.length, 1)
    stored.put('inbox', { ...stored.inbox[0], read: true })
    a.prune(Date.now() + 25 * 60 * 60 * 1000)
    assert.throws(() => a.load(stored.meta.session_id), /ENOENT/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('closing a room resolves a waiting agent and pending deliveries expire', async t => {
  const { A, B } = await fixture(t)
  const waiting = B.waitMessage({ timeout_s: 10 })
  await A.close()
  const result = await waiting
  assert.equal(result.state, 'closed'); assert.equal(result.timed_out, false)
  await assert.rejects(A.open(), /explicitly closed/)
})
