const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { notice } = require('./agent-notice')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function readJSON(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Invalid local session record')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function readSnapshot({ sessionId, projectDir = process.env.FAIRDROP_PROJECT_DIR || process.cwd(), root = process.env.FAIRDROP_AGENT_DIR || path.join(os.homedir(), '.local/share/fairdrop/agents') }) {
  if (!uuid.test(sessionId)) throw new Error('Invalid local session ID')
  const scope = crypto.createHash('sha256').update(path.resolve(projectDir)).digest('hex')
  const directory = path.join(path.resolve(root), scope, sessionId), inbox = path.join(directory, 'inbox')
  for (const dir of [path.dirname(directory), directory, inbox]) { const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid local session directory') }
  const meta = readJSON(path.join(directory, 'session.json'))
  if (meta.session_id !== sessionId) throw new Error('Invalid local session metadata')
  const messages = fs.readdirSync(inbox).filter(name => name.endsWith('.json') && uuid.test(name.slice(0, -5))).map(name => readJSON(path.join(inbox, name)))
  for (const m of messages) if (!uuid.test(m.message_id) || !Number.isSafeInteger(m.sequence) || m.sequence < 1) throw new Error('Invalid inbox record')
  let online = false
  try { const pid = Number(fs.readFileSync(path.join(directory, 'lock'), 'utf8')); if (Number.isSafeInteger(pid) && pid > 0) { process.kill(pid, 0); online = true } } catch (err) { if (err.code === 'EPERM') online = true; else if (!['ENOENT', 'ESRCH'].includes(err.code)) throw err }
  return { directory, inbox, meta: { closed: meta.closed, expires_at: meta.expires_at }, online, events: messages.filter(m => meta.inbox_sequence === undefined || m.sequence <= meta.inbox_sequence).sort((a,b) => a.sequence - b.sequence).map(m => notice(sessionId, m)) }
}
async function listen(options, { output = process.stdout, signal, intervalMs = 1000 } = {}) {
  let cursor = Number(options.since ?? 0), online, pendingWake, watcher
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid listener cursor')
  const write = async event => { if (!output.write(JSON.stringify(event) + '\n')) await once(output, 'drain', { signal }) }
  try {
    while (!signal?.aborted) {
      const snapshot = readSnapshot(options)
      if (!watcher) { try { watcher = fs.watch(snapshot.inbox, () => pendingWake?.()) } catch {} }
      for (const event of snapshot.events) if (event.sequence > cursor) { await write(event); cursor = event.sequence }
      if (snapshot.meta.closed || Date.now() >= snapshot.meta.expires_at) {
        const expired = Date.now() >= snapshot.meta.expires_at
        await write({ type: expired ? 'expired' : 'closed', session_id: options.sessionId, cursor: String(cursor) })
        return expired ? 3 : 2
      }
      if (online !== snapshot.online) { online = snapshot.online; await write({ type: 'connection', session_id: options.sessionId, receiver_process_alive: online, warning: online ? null : 'Receiver MCP is offline; listener does not receive remote messages or restart it' }) }
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); pendingWake = null; signal?.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, intervalMs); pendingWake = done; signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done()
      })
    }
    return 0
  } finally { watcher?.close() }
}
async function main(args) {
  const options = {}, names = { '--session': 'sessionId', '--since': 'since', '--project-dir': 'projectDir', '--store-dir': 'root' }
  try {
    if (args.includes('--help')) { process.stdout.write('fairdrop-mcp listen --session <local UUID> [--since <sequence>] [--project-dir <path>] [--store-dir <path>]\n'); return }
    for (let i = 0; i < args.length; i += 2) { if (!names[args[i]] || !args[i+1]) throw new Error('Invalid listener arguments; use listen --help'); options[names[args[i]]] = args[i+1] }
    if (!options.sessionId) throw new Error('Use --session with your LOCAL session_id')
    const controller = new AbortController(); process.stdout.on('error', err => { if (err.code === 'EPIPE') controller.abort() }); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort())
    process.exitCode = await listen(options, { signal: controller.signal })
  } catch (err) { if (err.name === 'AbortError' || err.code === 'EPIPE') return; process.stderr.write('fairdrop listener: ' + (err.code === 'ENOENT' ? 'Session not found in this project scope' : err.message) + '\n'); process.exitCode = err.code === 'ENOENT' ? 4 : 1 }
}
module.exports = { notice, readSnapshot, listen, main }
