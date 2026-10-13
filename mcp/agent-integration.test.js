const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { broker, until, sdkPeer, rawPeer } = require('./agent-test-helpers')

for (const relay of [true, false]) {
  test(`independent MCP harnesses collaborate bidirectionally over encrypted ${relay ? 'relay' : 'P2P'}`, { timeout: 40000 }, async () => {
    const hub = await broker()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-agents-'))
    const env = { FAIRDROP_URL: hub.url, FAIRDROP_AGENT_DIR: root, FAIRDROP_AGENT_RELAY_ONLY: relay ? '1' : '0' }
    const peers = []
    try {
      const api = await sdkPeer({ ...env, FAIRDROP_PROJECT_DIR: path.join(root, 'api') }); peers.push(api)
      const front = await rawPeer({ ...env, FAIRDROP_PROJECT_DIR: path.join(root, 'front') }); peers.push(front)
      assert.match(front.initialized.instructions, /wait_message/)
      const { tools } = await front.request('tools/list', {})
      for (const name of ['create', 'join', 'send', 'inbox', 'wait_message', 'ack', 'status', 'resume', 'close']) {
        const tool = tools.find(t => t.name === 'fairdrop_agent_' + name)
        assert.ok(tool?.description && tool.inputSchema.type === 'object')
      }
      const created = await api.call('fairdrop_agent_create', { alias: 'api-vps', project: 'backend' })
      const joined = await front.call('fairdrop_agent_join', { alias: 'frontend-local', code: created.pairing_code })
      assert.notEqual(created.session_id, joined.session_id)
      await until(async () => (await api.call('fairdrop_agent_status', { session_id: created.session_id })).state === 'connected')
      const connected = await front.call('fairdrop_agent_status', { session_id: joined.session_id })
      assert.equal(connected.state, 'connected'); assert.equal(connected.transport, relay ? 'relay' : 'p2p')
      // The frontend is already waiting: arrival returns without a user reminder.
      const wait = front.call('fairdrop_agent_wait_message', { session_id: joined.session_id, timeout_s: 10 })
      const messageId = crypto.randomUUID()
      const details = { base_url: 'https://api.example.test', method: 'GET', path: '/users', response_example: { users: [{ id: '123', name: 'Ana' }] } }
      await api.call('fairdrop_agent_send', { session_id: created.session_id, message_id: messageId, kind: 'api_ready', format: 'json', data: details })
      const arrived = await wait
      assert.equal(arrived.timed_out, false); assert.equal(arrived.messages.length, 1)
      assert.deepEqual(arrived.messages[0].body.json, details)
      assert.equal(arrived.messages[0].from.alias, 'api-vps'); assert.equal(arrived.messages[0].read, false)
      await until(async () => (await api.call('fairdrop_agent_status', { session_id: created.session_id, message_id: messageId })).sent[0].state === 'delivered')
      await front.call('fairdrop_agent_ack', { session_id: joined.session_id, message_ids: [messageId] })
      await until(async () => (await api.call('fairdrop_agent_status', { session_id: created.session_id, message_id: messageId })).sent[0].state === 'read')
      const replyWait = api.call('fairdrop_agent_wait_message', { session_id: created.session_id, timeout_s: 10 })
      const reply = await front.call('fairdrop_agent_send', { session_id: joined.session_id, reply_to: messageId, text: 'The endpoint works; tests passed.' })
      const response = await replyWait
      assert.equal(response.messages[0].reply_to, messageId)
      await until(async () => (await api.call('fairdrop_agent_status', { session_id: created.session_id, message_id: messageId })).sent[0].state === 'replied')
      assert.equal((await api.call('fairdrop_agent_status', { session_id: created.session_id })).state, 'connected')
      // Repeating the same message ID does not duplicate inbox entries.
      await api.call('fairdrop_agent_send', { session_id: created.session_id, message_id: messageId, kind: 'api_ready', format: 'json', data: details })
      assert.equal((await front.call('fairdrop_agent_inbox', { session_id: joined.session_id, cursor: '0' })).messages.length, 1)
      // Inline content can instead be materialized as a local .txt attachment.
      const contents = 'Contract as a file, not inline.'
      const fileWait = front.call('fairdrop_agent_wait_message', { session_id: joined.session_id, cursor: arrived.next_cursor, timeout_s: 10 })
      const fileMessage = await api.call('fairdrop_agent_send', { session_id: created.session_id, format: 'file', text: contents, filename: 'contract.txt' })
      const fileResult = await fileWait
      assert.equal(fileResult.messages.length, 1, JSON.stringify({ fileResult, status: await api.call('fairdrop_agent_status', { session_id: created.session_id, message_id: fileMessage.message_id }) }))
      const attachment = fileResult.messages[0].attachments[0]
      assert.equal(attachment.name, 'contract.txt'); assert.equal(fs.readFileSync(attachment.path, 'utf8'), contents)
      assert.ok(attachment.path.startsWith(root)); assert.equal(fs.statSync(attachment.path).mode & 0o777, 0o600)
      await until(async () => (await api.call('fairdrop_agent_status', { session_id: created.session_id, message_id: fileMessage.message_id })).sent[0].state === 'delivered')
      // Concurrent messages/attachments in opposite directions remain independent.
      const large = path.join(root, 'large.bin'); const bytes = crypto.randomBytes(3 * 1024 * 1024); fs.writeFileSync(large, bytes)
      const empty = path.join(root, 'empty.txt'); fs.writeFileSync(empty, '')
      const nextA = api.call('fairdrop_agent_wait_message', { session_id: created.session_id, cursor: response.next_cursor, timeout_s: 10 })
      const nextB = front.call('fairdrop_agent_wait_message', { session_id: joined.session_id, cursor: fileResult.next_cursor, timeout_s: 10 })
      await Promise.all([
        api.call('fairdrop_agent_send', { session_id: created.session_id, text: 'large attachment', attachments: [large] }),
        front.call('fairdrop_agent_send', { session_id: joined.session_id, text: 'empty attachment', attachments: [empty] }),
      ])
      const [a, b] = await Promise.all([nextA, nextB])
      assert.equal(fs.statSync(a.messages[0].attachments[0].path).size, 0)
      assert.deepEqual(fs.readFileSync(b.messages[0].attachments[0].path), bytes)
      // Raw relay envelopes contain neither shared secret nor message bodies.
      const captured = JSON.stringify(hub.captured)
      assert.ok(!captured.includes('api.example.test')); assert.ok(!captured.includes('The endpoint works'))
      const invitationKey = created.pairing_code
      assert.ok(!captured.includes(invitationKey)); assert.ok(!api.stderr.includes(invitationKey)); assert.ok(!front.stderr.includes(invitationKey))
      const emptyWait = await front.call('fairdrop_agent_wait_message', { session_id: joined.session_id, cursor: b.next_cursor, timeout_s: 0.1 })
      assert.equal(emptyWait.timed_out, true); assert.deepEqual(emptyWait.messages, [])
      // A guest closing is communicated as a close, rather than an endless reconnect.
      await front.call('fairdrop_agent_close', { session_id: joined.session_id })
      await until(async () => (await api.call('fairdrop_agent_status', { session_id: created.session_id })).state === 'closed')
      assert.ok(reply.message_id)
    } finally {
      for (const peer of peers) await peer.close()
      await hub.close(); fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
