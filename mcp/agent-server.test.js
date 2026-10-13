const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { exchange } = require('./agent-network-smoke')
const { until } = require('./agent-test-helpers')

test('agent rooms interoperate with the real signaling server without server changes or stored message contents', { timeout: 30000 }, async () => {
  const reservation = net.createServer()
  await new Promise(r => reservation.listen(0, '127.0.0.1', r))
  const port = reservation.address().port
  await new Promise(r => reservation.close(r))
  const server = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  server.stdout.on('data', data => { logs += data.toString() }); server.stderr.on('data', data => { logs += data.toString() })
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/status`)).ok } catch { return false } }, 5000)
    const result = await exchange(`ws://127.0.0.1:${port}/ws`)
    assert.equal(result.transport, 'relay'); assert.equal(result.encryption, 'TLSv1.3-PSK')
    assert.ok(!logs.includes('Frontend test result: OK'))
    await until(async () => (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).rooms === 0)
  } finally {
    const exited = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await exited
  }
})
