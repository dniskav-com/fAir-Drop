const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { until, sdkPeer, rawPeer } = require('./agent-test-helpers')

async function exchange(url, { relay = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-network-'))
  const env = { FAIRDROP_URL: url, FAIRDROP_AGENT_DIR: root, FAIRDROP_AGENT_RELAY_ONLY: relay ? '1' : '0' }
  let api, frontend
  try {
    api = await sdkPeer({ ...env, FAIRDROP_PROJECT_DIR: path.join(root, 'api') })
    frontend = await rawPeer({ ...env, FAIRDROP_PROJECT_DIR: path.join(root, 'frontend') })
    const a = await api.call('fairdrop_agent_create', { alias: 'api-network-test' })
    const b = await frontend.call('fairdrop_agent_join', { invitation: a.invitation, alias: 'frontend-network-test' })
    await until(async () => (await api.call('fairdrop_agent_status', { session_id: a.session_id })).state === 'connected', 20000)
    const waiting = frontend.call('fairdrop_agent_wait_message', { session_id: b.session_id, timeout_s: 10 })
    const details = { method: 'GET', path: '/users', response_example: { users: [] } }
    const msg = await api.call('fairdrop_agent_send', { session_id: a.session_id, kind: 'api_ready', format: 'json', data: details })
    const arrival = await waiting
    assert.deepEqual(arrival.messages[0].body.json, details)
    await frontend.call('fairdrop_agent_ack', { session_id: b.session_id, message_ids: [msg.message_id] })
    await until(async () => (await api.call('fairdrop_agent_status', { session_id: a.session_id, message_id: msg.message_id })).sent[0].state === 'read')
    const replyWait = api.call('fairdrop_agent_wait_message', { session_id: a.session_id, timeout_s: 10 })
    await frontend.call('fairdrop_agent_send', { session_id: b.session_id, reply_to: msg.message_id, format: 'file', text: 'Frontend test result: OK', filename: 'result.txt' })
    const reply = await replyWait
    assert.equal(fs.readFileSync(reply.messages[0].attachments[0].path, 'utf8'), 'Frontend test result: OK')
    await until(async () => (await api.call('fairdrop_agent_status', { session_id: a.session_id, message_id: msg.message_id })).sent[0].state === 'replied')
    const state = await api.call('fairdrop_agent_status', { session_id: a.session_id })
    await api.call('fairdrop_agent_close', { session_id: a.session_id })
    await until(async () => (await frontend.call('fairdrop_agent_status', { session_id: b.session_id })).state === 'closed')
    return { transport: state.transport, encryption: state.encryption, messages: 2, result: 'delivered, read, replied, attachment verified, room closed' }
  } finally {
    if (api) await api.close()
    if (frontend) await frontend.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

module.exports = { exchange }
if (require.main === module) {
  const url = process.argv[2]
  if (!url) { console.error('Usage: node mcp/agent-network-smoke.js <ws://.../ws or wss://.../ws> [--p2p]'); process.exitCode = 1 }
  else exchange(url, { relay: !process.argv.includes('--p2p') }).then(result => console.log(JSON.stringify(result))).catch(err => { console.error(err.message); process.exitCode = 1 })
}
