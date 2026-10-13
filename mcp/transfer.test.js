const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

for (const relay of [false, true]) {
  test(`MCP transfers multiple files using ${relay ? 'relay fallback' : 'native P2P'}`, { timeout: 30000 }, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise(resolve => server.on('listening', resolve))
    let host, guest
    server.on('connection', ws => ws.on('message', (data, binary) => {
      const peer = ws === host ? guest : host
      if (binary) { peer?.send(data, { binary: true }); return }
      const msg = JSON.parse(data)
      if (msg.type === 'create-room') { host = ws; ws.send(JSON.stringify({ type: 'room-created', code: 'TEST' })); return }
      if (msg.type === 'join-room') {
        guest = ws
        ws.send(JSON.stringify({ type: 'room-joined', code: 'TEST' }))
        host.send(JSON.stringify({ type: 'peer-joined' }))
        return
      }
      if (relay && ['offer', 'answer', 'ice-candidate'].includes(msg.type)) return
      peer?.send(data.toString())
    }))
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-mcp-'))
    const inputs = [Buffer.alloc(2 * 1024 * 1024, 123), Buffer.alloc(0)]
    const files = inputs.map((data, i) => { const file = path.join(directory, `${i}.bin`); fs.writeFileSync(file, data); return file })
    const clients = []
    let receivedDirectory
    let logs = ''
    async function connect() {
      const client = new Client({ name: 'transfer-test', version: '1' })
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'index.js')], env: { ...process.env, FAIRDROP_URL: `ws://127.0.0.1:${server.address().port}` }, stderr: 'pipe' })
      transport.stderr.on('data', data => { logs += data.toString() })
      clients.push(client)
      await client.connect(transport)
      return client
    }
    const call = async (client, name, args) => {
      const result = await client.callTool({ name, arguments: args })
      assert.ok(!result.isError, JSON.stringify(result))
      return JSON.parse(result.content[0].text)
    }
    try {
      const sender = await connect()
      const receiver = await connect()
      const invalid = await sender.callTool({ name: 'fairdrop_create_session', arguments: { files: [directory] } })
      assert.equal(invalid.isError, true)
      const missing = await call(sender, 'fairdrop_wait_session', { room_code: 'NONE', timeout_s: 1 })
      assert.equal(missing.state, 'not_found')
      const created = await call(sender, 'fairdrop_create_session', { files })
      const waiting = await call(sender, 'fairdrop_wait_session', { room_code: created.room_code, timeout_s: 1 })
      assert.equal(waiting.state, 'waiting')
      const receiving = await call(receiver, 'fairdrop_receive_session', { room_code: created.room_code })
      receivedDirectory = receiving.directory
      const sent = await call(sender, 'fairdrop_wait_session', { room_code: created.room_code, timeout_s: 20 })
      assert.equal(sent.state, 'sent', JSON.stringify(sent))
      assert.deepEqual(sent.sent.map(f => f.size_bytes), inputs.map(b => b.length))
      let result
      for (let i = 0; i < 100; i++) {
        result = await call(receiver, 'fairdrop_session_status', { room_code: created.room_code })
        if (result.received.length === 2) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.equal(result.received.length, 2, JSON.stringify(result))
      for (let i = 0; i < inputs.length; i++) assert.deepEqual(fs.readFileSync(result.received[i].path), inputs[i])
      assert.match(logs, relay ? /transporte: relay WS/ : /transporte: WebRTC P2P/)
    } finally {
      for (const client of clients) await client.close()
      for (const ws of server.clients) ws.terminate()
      await new Promise(resolve => server.close(resolve))
      fs.rmSync(directory, { recursive: true, force: true })
      if (receivedDirectory) fs.rmSync(receivedDirectory, { recursive: true, force: true })
    }
  })
}
