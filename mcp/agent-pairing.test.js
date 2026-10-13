const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Pairing, parseCode, newPin } = require('./agent-pairing')
const { AgentManager } = require('./agent-tools')
const { broker, until } = require('./agent-test-helpers')
function pair(pin = '1234') {
  const meta = { code: 'ABCD', pairing_pin: '1234', conversation_id: crypto.randomUUID(), expires_at: Date.now() + 60000 }
  return [new Pairing(meta, 'creator', 'guest'), new Pairing({ ...meta, pairing_pin: pin }, 'creator', 'guest')]
}
test('SRP authenticates both peers, derives a strong key and rejects incorrect passwords', () => {
  const [a,b] = pair(); b.confirm(a.verify(b.answer(a.challenge())))
  assert.deepEqual(a.config(), b.config()); assert.equal(Buffer.from(a.config().secret, 'base64url').length, 32)
  const [c,d] = pair('9999'); assert.throws(() => c.verify(d.answer(c.challenge()))); assert.throws(() => c.config())
})
test('codes normalize human input and reject four-character browser room codes', () => {
  assert.deepEqual(parseCode('abcd-12oL'), { code: 'ABCD', pairing_pin: '1201' })
  assert.throws(() => parseCode('ABCD')); assert.throws(() => parseCode('ABCDUUUU'))
  assert.match(newPin(), /^[0-9A-HJKMNP-TV-Z]{4}$/)
})
test('SRP rejects tampered context, invalid public values and fake server confirmation', () => {
  let [a,b] = pair(); const challenge = a.challenge(); challenge.conversation_id = crypto.randomUUID()
  assert.throws(() => a.verify(b.answer(challenge)))
  ;[a,b] = pair(); const proof = b.answer(a.challenge()); proof.A = '0'.repeat(768); assert.throws(() => a.verify(proof))
  ;[a,b] = pair(); b.answer(a.challenge()); assert.throws(() => b.confirm({ proof: '0'.repeat(128) }))
})
async function fixture(t) {
  const hub = await broker(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-code-'))
  const managers = []
  const manager = () => { const m = new AgentManager({ url: hub.url, storeOptions: { root, projectDir: path.join(root, String(managers.length)) }, transportOptions: { relayOnly: true } }); managers.push(m); return m }
  t.after(async () => { managers.forEach(m => m.shutdown()); await hub.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { hub, manager }
}
test('wrong PIN keeps host alive, correct retry delivers automatically and consumes code', async t => {
  const { hub, manager } = await fixture(t), a = manager(), b = manager(), c = manager()
  const created = await a.create({ alias: 'api' }), A = a.get(created.session_id)
  assert.equal(created.pairing_code.length, 8); assert.equal(created.invitation, undefined)
  const wrong = created.pairing_code.slice(0,4) + (created.pairing_code.slice(4) === '0000' ? '1111' : '0000')
  const bad = await b.join({ code: wrong, alias: 'wrong' })
  await until(() => b.get(bad.session_id).state === 'error' && A.state === 'waiting_peer' && !hub.rooms.get(A.store.meta.code).guest)
  assert.equal(A.store.meta.pairing_attempts, 1)
  const joined = await c.join({ code: created.pairing_code.toLowerCase(), alias: 'front' }), C = c.get(joined.session_id)
  await until(() => A.state === 'connected' && C.state === 'connected')
  assert.equal(A.store.meta.pairing_pin, null); assert.equal(A.store.meta.secret, C.store.meta.secret)
  const wait = C.waitMessage({ timeout_s: 5 }); A.enqueue({ text: 'endpoint ready' })
  assert.equal((await wait).messages[0].body.text, 'endpoint ready')
  assert.ok(!JSON.stringify(hub.captured).includes(A.store.meta.secret))
  C.detach(); await until(() => !hub.rooms.get(A.store.meta.code).guest)
  const d = manager(), used = await d.join({ code: created.pairing_code, alias: 'reuse' })
  await until(() => d.get(used.session_id).state === 'error' && !hub.rooms.get(A.store.meta.code).guest)
  assert.equal(A.state, 'reconnecting')
  await c.resume(joined.session_id); await until(() => A.state === 'connected' && C.state === 'connected')
})
test('host caps guesses at five and expired codes cannot pair', async t => {
  const { hub, manager } = await fixture(t), a = manager()
  const created = await a.create({ alias: 'api' }), A = a.get(created.session_id)
  const wrong = created.pairing_code.slice(0,4) + (created.pairing_code.slice(4) === '0000' ? '1111' : '0000')
  for (let i = 0; i < 5; i++) {
    const b = manager(), result = await b.join({ code: wrong, alias: 'wrong' })
    await until(() => b.get(result.session_id).state === 'error' && !hub.rooms.get(A.store.meta.code).guest)
  }
  const b = manager(), result = await b.join({ code: created.pairing_code, alias: 'right-too-late' })
  await until(() => b.get(result.session_id).state === 'error' && !hub.rooms.get(A.store.meta.code).guest)
  assert.equal(A.store.meta.pairing_attempts, 5)
  const next = await a.create({ alias: 'expired' }), E = a.get(next.session_id)
  E.store.saveMeta({ pairing_expires_at: Date.now() - 1 }); E.transport.meta.pairing_expires_at = Date.now() - 1
  E.tick(); await until(() => E.state === 'expired')
})

test('restarting an unpaired creator preserves PIN, deadline and attempt cap', async t => {
  const { hub, manager } = await fixture(t), a = manager(), b = manager()
  const created = await a.create({ alias: 'api' }), A = a.get(created.session_id)
  const pin = A.store.meta.pairing_pin, deadline = A.store.meta.pairing_expires_at
  A.store.saveMeta({ pairing_attempts: 5 }); A.detach()
  await until(() => !hub.rooms.get(created.room_code).host)
  a.sessions.delete(created.session_id)
  await a.resume(created.session_id)
  const restored = a.get(created.session_id)
  assert.equal(restored.store.meta.pairing_pin, pin); assert.equal(restored.store.meta.pairing_expires_at, deadline)
  const joined = await b.join({ code: created.pairing_code, alias: 'front' })
  await until(() => b.get(joined.session_id).state === 'error')
  assert.equal(restored.store.meta.pairing_attempts, 5)
})
