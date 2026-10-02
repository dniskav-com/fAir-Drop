const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const { receiveSession } = require('./receiver')

test('receives files safely and rejects incomplete transfers', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise(r => server.on('listening', r))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-test-'))
  server.on('connection', ws => ws.on('message', raw => {
    if (JSON.parse(raw).type === 'create-room') {
      ws.send(JSON.stringify({ type: 'room-created', code: 'TEST' }))
      ws.send(JSON.stringify({ type: 'relay-meta', payload: { type: 'file-start', fileId: '1', name: '../../example.txt', size: 3, totalChunks: 1 } }))
      ws.send(Buffer.from('abc'))
      ws.send(JSON.stringify({ type: 'relay-meta', payload: { type: 'file-end', fileId: '1' } }))
      ws.send(JSON.stringify({ type: 'relay-meta', payload: { type: 'file-start', fileId: '2', name: 'bad.txt', size: 4, totalChunks: 1 } }))
      ws.send(JSON.stringify({ type: 'relay-meta', payload: { type: 'file-end', fileId: '2' } }))
    }
  }))
  const session = receiveSession({ url: `ws://127.0.0.1:${server.address().port}`, directory })
  try {
    await session.ready
    await new Promise(r => setTimeout(r, 100))
    assert.equal(session.received.length, 1)
    assert.equal(path.dirname(session.received[0].path), session.directory)
    assert.equal(fs.readFileSync(session.received[0].path, 'utf8'), 'abc')
    assert.equal(session.state, 'error')
    assert.equal(fs.readdirSync(session.directory).length, 1)
  } finally {
    session.close()
    await new Promise(r => server.close(r))
    fs.rmSync(directory, { recursive: true })
  }
})
