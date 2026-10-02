const assert = require('node:assert/strict')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

async function main() {
  const client = new Client({ name: 'fairdrop-smoke-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [require('node:path').join(__dirname, 'index.js')],
    cwd: '/tmp',
    stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    for (const name of ['fairdrop_create_session', 'fairdrop_receive_session', 'fairdrop_session_status', 'fairdrop_status']) {
      assert.ok(tools.some(tool => tool.name === name), `Missing tool: ${name}`)
    }
    console.log('OK: MCP iniciado desde /tmp; herramientas de envío y recepción disponibles')
  } finally {
    await client.close()
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
