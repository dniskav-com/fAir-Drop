const { WebSocketServer } = require('ws')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { spawn } = require('node:child_process')
const path = require('node:path')
const assert = require('node:assert/strict')

async function broker() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(r => server.on('listening', r))
  const rooms = new Map(), captured = []
  let seq = 0
  server.on('connection', ws => {
    ws.on('message', (data, binary) => {
      const msg = binary ? null : JSON.parse(data.toString())
      captured.push(binary ? Buffer.from(data) : msg)
      const send = (socket, payload) => { if (socket?.readyState === 1) socket.send(JSON.stringify(payload)) }
      if (msg?.type === 'create-room') {
        const code = (++seq).toString(36).toUpperCase().padStart(4, '0')
        rooms.set(code, { host: ws, guest: null }); ws.code = code; ws.role = 'host'
        send(ws, { type: 'room-created', code }); return
      }
      if (['join-room', 'reclaim-room'].includes(msg?.type)) {
        const room = rooms.get(msg.code)
        if (!room) { send(ws, { type: 'error', message: 'Room not found' }); return }
        const role = msg.type === 'join-room' ? 'guest' : 'host'
        if (room[role]?.readyState === 1) { send(ws, { type: 'error', message: 'Room full' }); return }
        room[role] = ws; ws.role = role; ws.code = msg.code
        send(ws, { type: role === 'guest' ? 'room-joined' : 'room-reclaimed', code: msg.code })
        if (room.guest?.readyState === 1) send(room.host, { type: 'peer-joined' })
        return
      }
      const room = rooms.get(ws.code)
      const peer = room?.[ws.role === 'host' ? 'guest' : 'host']
      if (msg?.type === 'close-room') { rooms.delete(ws.code); send(peer, { type: 'room-closed' }); return }
      if (peer?.readyState === 1) peer.send(binary ? data : data.toString(), { binary })
    })
    ws.on('close', () => {
      const room = rooms.get(ws.code)
      if (!room || room[ws.role] !== ws) return
      room[ws.role] = null
      const peer = room[ws.role === 'host' ? 'guest' : 'host']
      if (peer?.readyState === 1) peer.send(JSON.stringify({ type: 'peer-disconnected' }))
    })
  })
  return { server, rooms, captured, url: `ws://127.0.0.1:${server.address().port}/ws`, close: async () => { for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)) } }
}

async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 20)) }
  throw new Error('Test condition timed out')
}

async function sdkPeer(env, cwd = '/tmp') {
  const client = new Client({ name: 'independent-sdk-harness', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'index.js')], cwd, env: { ...process.env, ...env }, stderr: 'pipe' })
  let stderr = ''
  transport.stderr.on('data', data => { stderr += data.toString() })
  await client.connect(transport)
  return {
    client, transport, get stderr() { return stderr },
    call: async (name, args, options) => { const r = await client.callTool({ name, arguments: args }, undefined, options); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text) },
    close: () => client.close(),
  }
}

// A second, SDK-independent harness exercises the public JSON-RPC contract.
async function rawPeer(env, cwd = '/tmp') {
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let sequence = 0, buffer = '', stderr = ''
  const pending = new Map()
  child.stderr.on('data', data => { stderr += data.toString() })
  child.stdout.on('data', data => {
    buffer += data.toString()
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (message.id !== undefined && pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result) }
    }
  })
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('Raw harness exited')); pending.clear() })
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'independent-raw-harness', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return {
    child, initialized, request, get stderr() { return stderr },
    call: async (name, args) => { const r = await request('tools/call', { name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text) },
    close: async () => { if (child.exitCode !== null) return; const exit = new Promise(r => child.once('exit', r)); child.stdin.end(); const timer = setTimeout(() => child.kill('SIGTERM'), 1000); await exit; clearTimeout(timer) },
  }
}

module.exports = { broker, until, sdkPeer, rawPeer }
