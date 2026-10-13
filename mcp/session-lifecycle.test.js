const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

for (const phase of ['negotiation', 'transfer']) {
  test(`peer disconnect during ${phase} cancels sending without reporting sent`, { timeout: 20000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-lifecycle-'))
    const file = path.join(directory, 'test.bin')
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024))
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise(r => server.on('listening', r))
    let socket, fileId
    server.on('connection', ws => {
      socket = ws
      ws.on('message', (raw, binary) => {
        if (binary) {
          ws.send(JSON.stringify({ type: 'peer-disconnected' }))
          return
        }
        const msg = JSON.parse(raw)
        if (msg.type === 'create-room') ws.send(JSON.stringify({ type: 'room-created', code: 'TEST' }))
        if (msg.type === 'relay-meta' && msg.payload.type === 'file-start') {
          fileId = msg.payload.fileId
          ws.send(JSON.stringify({ type: 'relay-meta', payload: { type: 'file-ready', fileId } }))
        }
      })
    })
    const client = new Client({ name: 'lifecycle-test', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'index.js')], env: { ...process.env, FAIRDROP_URL: `ws://127.0.0.1:${server.address().port}` }, stderr: 'pipe' })
    transport.stderr.on('data', () => {})
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args })
      assert.ok(!result.isError, JSON.stringify(result))
      return JSON.parse(result.content[0].text)
    }
    try {
      await client.connect(transport)
      await call('fairdrop_create_session', { files: [file] })
      socket.send(JSON.stringify({ type: 'peer-joined' }))
      if (phase === 'negotiation') socket.send(JSON.stringify({ type: 'peer-disconnected' }))
      const status = await call('fairdrop_wait_session', { room_code: 'TEST', timeout_s: 15 })
      assert.equal(status.state, 'error')
      assert.match(status.error, /desconectó/)
      assert.deepEqual(status.sent, [])
      // The async negotiation/transfer must not overwrite cancellation later.
      await new Promise(r => setTimeout(r, 800))
      assert.equal((await call('fairdrop_session_status', { room_code: 'TEST' })).state, 'error')
      assert.notEqual(socket.readyState, 1)
    } finally {
      await client.close()
      for (const ws of server.clients) ws.terminate()
      await new Promise(r => server.close(r))
      fs.rmSync(directory, { recursive: true })
    }
  })
}
