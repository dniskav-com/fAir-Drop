#!/usr/bin/env node
// fairdrop-mcp — Servidor MCP para que agentes de IA (en cualquier máquina,
// con acceso al signaling de producción) envíen archivos a una persona vía
// fAir Drop (salas + relay WebSocket). No necesita estar en el VPS: conecta
// por WSS a fair-drop.dniskav.com.
//
// Corre por stdio (local). No expone ninguna superficie pública: habla con
// el signaling de fAir Drop como un cliente más del protocolo WS.
//
// Flujo para el agente:
//   1. create_session → devuelve el código de sala AL INSTANTE
//   2. El agente le dice al usuario: "entra en https://fair-drop.dniskav.com
//      con el código XXXX y confirma las descargas"
//   3. session_status hasta que state === 'sent' (o 'done')
//   4. cancel_session si el usuario lo cancela
//
// Sin persistencia: las sesiones viven en memoria por diseño.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')
const WebSocket = require('ws')

const FAIRDROP_URL = process.env.FAIRDROP_URL || 'wss://fair-drop.dniskav.com/ws'
const STATUS_URL = process.env.FAIRDROP_STATUS_URL || 'https://fair-drop.dniskav.com/api/status'

const CHUNK_SIZE = 128 * 1024
const WAIT_PEER_MS = 15 * 60 * 1000 // expira la sala si nadie entra en 15 min
const GRACE_MS = 10 * 1000 // margen tras enviar, para que el par confirme descargas

// room_code -> { ws, files, state, sent, error, createdAt }
const sessions = new Map()

function log(msg) {
  process.stderr.write(`[fairdrop-mcp] ${msg}\n`)
}

function cleanup(session) {
  if (session.timer) { clearTimeout(session.timer); session.timer = null }
  if (session.channel) { try { session.channel.close() } catch {} session.channel = null; session.usingDC = false }
  if (session.ws) { try { session.ws.close() } catch {} session.ws = null }
  session.state = 'closed'
}

// P2P nativo: el emisor es el creador de la sala y lanza la offer.
// Devuelve una promesa que resuelve true si el DataChannel abrió,
// false si falló/timeout (el llamante envía entonces por relay WS).
function startChannelCreator(session) {
  let onOpenResolve
  const opened = new Promise((res) => { onOpenResolve = res })
  try {
    const { initChannel } = require('./webrtc')
    session.channel = initChannel({
      role: 'creator',
      onOpen: () => onOpenResolve(true),
      onSend: (m) => { if (session.ws) session.ws.send(JSON.stringify(m)) },
      onString: () => {},
      onBinary: () => {},
      onFail: () => {
        if (session.channel) { try { session.channel.close() } catch {} }
        session.channel = null
        onOpenResolve(false)
      },
    })
  } catch {
    onOpenResolve(false)
  }
  return opened
}

function sendFileChunks(session, file) {
  const sendMeta = (meta) => {
    if (session.usingDC && session.channel && session.channel.open) session.channel.send(JSON.stringify(meta))
    else session.ws.send(JSON.stringify({ type: 'relay-meta', payload: meta }))
  }
  const sendBin = (b) => {
    if (session.usingDC && session.channel && session.channel.open) session.channel.sendBinary(b)
    else session.ws.send(b, { binary: true })
  }

  const src = require('fs').readFileSync(file.path)
  const name = require('path').basename(file.path)
  const fileId = 'mcp-' + Date.now().toString(36) + '-' + (++session.seq)
  const totalChunks = Math.ceil(src.length / CHUNK_SIZE) || 1
  const ext = name.split('.').pop().toLowerCase()
  const mimeMap = {
    html: 'text/html', md: 'text/markdown', txt: 'text/plain',
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
    webp: 'image/webp', json: 'application/json', csv: 'text/csv',
    zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4',
  }
  const mime = mimeMap[ext] || 'application/octet-stream'

  sendMeta({ type: 'file-start', fileId, name, size: src.length, mimeType: mime, totalChunks })
  for (let i = 0; i < totalChunks; i++) sendBin(src.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
  sendMeta({ type: 'file-end', fileId })
  session.sent.push({ name, size_bytes: buf.length, chunks: totalChunks })
}

function openSession(session) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(FAIRDROP_URL)
    session.ws = ws
    session.seq = 0
    session.sent = []
    session.state = 'connecting'

    ws.on('error', (err) => { reject(new Error('conexión al signaling falló: ' + err.message)) })

    ws.on('message', async (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }

      if (msg.type === 'room-created') {
        session.code = msg.code
        session.state = 'waiting'
        // Expira si nadie se une en 15 min
        session.timer = setTimeout(() => {
          log('sesión ' + msg.code + ' expirada (sin par)')
          cleanup(session)
        }, WAIT_PEER_MS)
        resolve()
      }

      // Señalización entrante del par durante la sesión activa:
      // la respuesta del invitado y sus candidatos alimentan al canal P2P.
      if (msg.type === 'answer' || msg.type === 'ice-candidate') {
        if (session.channel) session.channel.onSignal(msg)
      }

      if (msg.type === 'peer-joined') {
        clearTimeout(session.timer)
        session.state = 'sending'
        // 1) Intentar DataChannel WebRTC (offer del creador). onFail interno
        // tras ~8 s resuelve false → relay por WS como siempre.
        const p2p = await startChannelCreator(session)
        session.usingDC = Boolean(p2p && session.channel && session.channel.open)
        log('transporte: ' + (session.usingDC ? 'WebRTC P2P' : 'relay WS'))
        if (!session.usingDC) {
          ws.send(JSON.stringify({ type: 'relay-mode' }))
          await new Promise((r) => setTimeout(r, 600))
        }
        try {
          for (const file of session.files) sendFileChunks(session, file)
          session.state = 'sent'
          log('archivos enviados en sala ' + session.code)
        } catch (e) {
          session.state = 'error'
          session.error = e.message
        }
        // Mantener la sala unos segundos más para que el par confirme descargas
        session.timer = setTimeout(() => cleanup(session), GRACE_MS)
      }

      if (msg.type === 'error') {
        session.state = 'error'
        session.error = msg.message
        cleanup(session)
      }
    })

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'create-room' }))
    })
  })
}

const server = new McpServer({ name: 'fairdrop-mcp', version: '1.0.0' })

server.tool(
  'fairdrop_receive_session',
  'Crea una sala para recibir archivos del usuario, o se une a su sala. Guarda archivos en una carpeta exclusiva y devuelve sus rutas mediante fairdrop_session_status. Límite: 512 MiB por archivo; sesión de 15 minutos.',
  { room_code: z.string().length(4).optional().describe('Sala del usuario; omitir para crear una nueva') },
  async ({ room_code }) => {
    try {
      const session = require('./receiver').receiveSession({
        url: FAIRDROP_URL,
        directory: require('path').join(__dirname, '../received'),
        code: room_code?.toUpperCase(),
      })
      await session.ready
      sessions.set(session.code, session)
      return { content: [{ type: 'text', text: JSON.stringify({ room_code: session.code, directory: session.directory, instructions_para_el_usuario: 'Entra en https://fair-drop.dniskav.com con el código ' + session.code + ' y envía tus archivos.' }) }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] }
    }
  },
)

server.tool(
  'fairdrop_create_session',
  'Crea una sala de fAir Drop y prepara el envío de archivos del VPS hacia una persona. Devuelve inmediatamente el código de sala (4 caracteres) que el usuario debe introducir en https://fair-drop.dniskav.com para recibir los archivos. Después consulta fairdrop_session_status para saber cuándo se enviaron. Solo para rutas absolutas legibles del servidor; los archivos viajan por el VPS en modo relay.',
  {
    files: z.array(z.string()).min(1).max(10)
      .describe('Rutas ABSOLUTAS de los archivos a enviar (máx. 10)'),
  },
  async ({ files }) => {
    for (const f of files) {
      if (!require('path').isAbsolute(f)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Las rutas deben ser absolutas: ' + f }) }] }
      }
      if (!require('fs').existsSync(f)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Archivo no encontrado: ' + f }) }] }
      }
    }
    const session = { files: files.map((path) => ({ path })), createdAt: Date.now() }
    sessions.set(session, true) // placeholder, se reasigna abajo por código
    try {
      await openSession(session)
      sessions.delete(session)
      sessions.set(session.code, session)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            room_code: session.code,
            join_url: 'https://fair-drop.dniskav.com',
            files: session.files.map((f) => require('path').basename(f.path)),
            instructions_para_el_usuario: 'Entra en https://fair-drop.dniskav.com con el código ' + session.code + ' y confirma las descargas. Los archivos se envían automáticamente al unirte. La sala expira en 15 minutos.',
          }),
        }],
      }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] }
    }
  },
)

server.tool(
  'fairdrop_session_status',
  'Consulta el estado de una sesión de envío de fAir Drop creada con fairdrop_create_session. Estados: connecting, waiting (esperando que el usuario entre con el código), sending, sent (archivos enviados, el usuario debe confirmar descargas), closed, error, expired.',
  {
    room_code: z.string().min(4).max(4).describe('Código de sala de 4 caracteres'),
  },
  async ({ room_code }) => {
    const s = sessions.get(room_code.toUpperCase())
    if (!s) {
      return { content: [{ type: 'text', text: JSON.stringify({ room_code, state: 'not_found', note: 'La sesión no existe o ya se cerró/limpió' }) }] }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          room_code: s.code,
          state: s.state,
          sent: s.sent,
          received: s.received,
          directory: s.directory,
          error: s.error ?? null,
          pending_descarga_usuario: s.state === 'sent',
        }),
      }],
    }
  },
)

server.tool(
  'fairdrop_wait_session',
  'Bloquea hasta que la sesión alcance un estado terminal (sent/received = listo, closed/error/expired = terminó) o venza el timeout. Devuelve el mismo payload que fairdrop_session_status. Úsala en vez de sondear en bucle: el tiempo de espera consumido aquí NO gasta tokens del agente. Si expira sin estado terminal devuelve state "waiting" y puedes volver a llamar.',
  {
    room_code: z.string().min(4).max(4).describe('Código de sala de 4 caracteres'),
    timeout_s: z.number().int().min(1).max(240).default(60)
      .describe('Segundos máximos de espera (default 60; llamar de nuevo si devuelve waiting)'),
  },
  async ({ room_code, timeout_s }) => {
    const code = room_code.toUpperCase()
    const TERMINALES = new Set(['sent', 'received', 'closed', 'error', 'expired', 'not_found'])
    const deadline = Date.now() + timeout_s * 1000
    const captura = (s) => JSON.stringify(s
      ? {
          room_code: s.code,
          state: s.state,
          sent: s.sent,
          received: s.received,
          directory: s.directory,
          error: s.error ?? null,
          pending_descarga_usuario: s.state === 'sent',
        }
      : { room_code: code, state: 'not_found', note: 'La sesión no existe o ya se cerró/limpió' })
    while (Date.now() < deadline) {
      const s = sessions.get(code)
      const sSnap = s && TERMINALES.has(s.state) ? captura(s) : (!s ? captura(null) : null)
      if (sSnap) return { content: [{ type: 'text', text: sSnap }] }
      await new Promise((r) => setTimeout(r, 1500))
    }
    return { content: [{ type: 'text', text: captura(sessions.get(code)) }] }
  },
)

server.tool(
  'fairdrop_status',
  'Estado público del servidor fAir Drop: salas activas y clientes conectados (sin datos personales).',
  {},
  async () => {
    try {
      const res = await fetch(STATUS_URL)
      const data = await res.json()
      return { content: [{ type: 'text', text: JSON.stringify({ rooms: data.rooms, clients: data.clients, uptime_seconds: data.uptime }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'no se pudo consultar el servidor: ' + e.message }) }] }
    }
  },
)

server.connect(new StdioServerTransport())
log('servidor MCP iniciado (stdio) — signaling: ' + FAIRDROP_URL)
