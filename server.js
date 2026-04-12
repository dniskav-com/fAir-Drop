const express = require('express')
const { WebSocketServer } = require('ws')
const http = require('http')
const path = require('path')
const QRCode = require('qrcode')
const { rateLimit } = require('express-rate-limit')

const app = express()
const server = http.createServer(app)

// noServer: true para filtrar el upgrade solo en /ws
// (permite que Vite dev server use otros paths en desarrollo)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  } else {
    socket.destroy()
  }
})

// Rate limit para la API QR: 60 requests por IP cada minuto
const qrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
})

// Rate limit para salas via WebSocket: se aplica al upgrade HTTP
// Express no intercepta WebSocket directamente, asi que limitamos
// el endpoint de status y estaticos de forma ligera.
// Las salas se limitan a nivel WS (ver mas abajo: wsRoomCount por IP).
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
})

// En producción sirve el build de Vite; en desarrollo Vite corre su propio servidor
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')))
  // SPA fallback para rutas no-API (ej: acceso directo a /?room=XXXX)
  app.get('*splat', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/status') return next()
    res.sendFile(path.join(__dirname, 'dist', 'index.html'))
  })
}

app.get('/api/qr', qrLimiter, async (req, res) => {
  const text = String(req.query.text ?? '').trim()
  if (!text || text.length > 512) {
    res.status(400).json({ error: 'Texto QR invalido' })
    return
  }

  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: {
        dark: '#17202a',
        light: '#ffffff'
      }
    })
    res.type('image/svg+xml').send(svg)
  } catch {
    res.status(500).json({ error: 'No se pudo generar el QR' })
  }
})

// rooms: code -> { creator: ws, joiner: ws | null, createdAt, mode }
const rooms = new Map()

// Meta por cliente: ws -> { ip, userAgent, connectedAt }
const clients = new Map()

// Bans: ip -> { until: Date | null }  (null = permanente)
const bans = new Map()

function isBanned(ip) {
  const ban = bans.get(ip)
  if (!ban) return false
  if (ban.until === null) return true // permanente
  if (ban.until > new Date()) return true // temporal vigente
  bans.delete(ip) // expiró, limpiar
  return false
}

function banLabel(ban) {
  if (!ban) return ''
  if (ban.until === null) return 'permanente'
  const secsLeft = Math.ceil((ban.until - Date.now()) / 1000)
  return `temporal (${secsLeft}s restantes)`
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return rooms.has(code) ? generateCode() : code
}

function getPeer(ws) {
  for (const [code, room] of rooms.entries()) {
    if (room.creator === ws) return { code, room, role: 'creator', peer: room.joiner }
    if (room.joiner === ws) return { code, room, role: 'joiner', peer: room.creator }
  }
  return null
}

function send(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function clientInfo(ws) {
  return clients.get(ws) ?? { ip: '?', userAgent: '?', connectedAt: null }
}

function peerSummary(info) {
  const ua = info.userAgent ?? ''
  let browser = 'Navegador'
  if (/Edg\//i.test(ua)) browser = 'Edge'
  else if (/Chrome/i.test(ua)) browser = 'Chrome'
  else if (/Firefox/i.test(ua)) browser = 'Firefox'
  else if (/Safari/i.test(ua)) browser = 'Safari'
  const mobile = /mobile|android|iphone|ipad/i.test(ua)
  return {
    ip: info.ip,
    browser,
    mobile,
    connectedAt: info.connectedAt?.toISOString() ?? null
  }
}

function elapsed(date) {
  if (!date) return '?'
  const s = Math.floor((Date.now() - date) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// ── Status API ────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const data = {
    rooms: rooms.size,
    clients: clients.size,
    uptime: Math.floor(process.uptime()),
    bans: [...bans.entries()].map(([ip, b]) => ({
      ip,
      type: b.until ? 'temporal' : 'permanente',
      label: banLabel(b)
    })),
    rooms_detail: []
  }

  for (const [code, room] of rooms.entries()) {
    const creator = clientInfo(room.creator)
    const joiner = room.joiner ? clientInfo(room.joiner) : null
    data.rooms_detail.push({
      code,
      mode: room.mode ?? 'p2p',
      created_ago: elapsed(room.createdAt),
      creator: { ip: creator.ip, ua: creator.userAgent, since: elapsed(creator.connectedAt) },
      joiner: joiner
        ? { ip: joiner.ip, ua: joiner.userAgent, since: elapsed(joiner.connectedAt) }
        : null
    })
  }

  res.json(data)
})

// ── Status page ───────────────────────────────────────────────
app.get('/status', statusLimiter, (_req, res) => {
  const base = process.env.NODE_ENV === 'production' ? 'dist' : 'public'
  res.sendFile(path.join(__dirname, base, 'status.html'))
})

// Rate limit para creacion de salas por IP via WebSocket
// Max 20 salas por IP en una ventana de 15 minutos
const wsRoomCount = new Map()
setInterval(() => wsRoomCount.clear(), 15 * 60 * 1000)
const WS_ROOM_LIMIT = 20

// ─── WebSocket ────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress ?? '?'
  // Normalize IPv6 mapped IPv4 (e.g. ::ffff:192.168.1.1) to plain IPv4 for display
  const normIp = String(ip).replace(/^::ffff:/, '')
  const userAgent = req.headers['user-agent'] ?? '?'
  const isMobile = /mobile|android|iphone|ipad/i.test(userAgent)
  console.log(`[WS] CONNECT  ${normIp}  ${isMobile ? '📱 mobile' : '🖥️ desktop'}`)

  // Rechazar conexión si la IP está baneada
  if (isBanned(normIp)) {
    const ban = bans.get(normIp)
    const reason =
      ban?.until === null
        ? 'Has sido baneado permanentemente de este servidor.'
        : `Has sido baneado temporalmente. Intenta de nuevo en ${Math.ceil((ban.until - Date.now()) / 1000)}s.`
    ws.send(JSON.stringify({ type: 'banned', reason }))
    ws.close()
    return
  }

  clients.set(ws, { ip: normIp, userAgent, connectedAt: new Date() })

  ws.on('message', (data, isBinary) => {
    // ── Relay binario (chunks de archivo) ──────────────────────
    if (isBinary) {
      const info = getPeer(ws)
      console.log(`[RELAY] binary chunk  ${info?.code ?? '?'}  ${data.length}b  from=${normIp}`)
      if (info?.peer && info.peer.readyState === info.peer.OPEN) {
        info.peer.send(data, { binary: true })
      }
      return
    }

    // ── Mensajes JSON ──────────────────────────────────────────
    let msg
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }

    switch (msg.type) {
      case 'create-room': {
        const roomCount = (wsRoomCount.get(normIp) ?? 0) + 1
        if (roomCount > WS_ROOM_LIMIT) {
          console.log(`[ROOM] RATE LIMIT  create  from=${normIp}`)
          send(ws, {
            type: 'error',
            message: 'Demasiadas salas creadas. Intenta de nuevo en unos minutos.'
          })
          break
        }
        wsRoomCount.set(normIp, roomCount)
        const code = generateCode()
        rooms.set(code, { creator: ws, joiner: null, createdAt: new Date(), mode: 'p2p' })
        console.log(`[ROOM] CREATED  ${code}  by ${normIp}`)
        send(ws, { type: 'room-created', code })
        send(ws, { type: 'client-info', self: peerSummary(clientInfo(ws)), peer: null })
        break
      }

      case 'join-room': {
        const code = msg.code?.toUpperCase()
        const room = rooms.get(code)
        if (!room) {
          console.log(`[ROOM] JOIN FAIL  ${code}  not found  from ${normIp}`)
          send(ws, { type: 'error', message: 'Sala no encontrada' })
          return
        }
        if (!room.creator || room.creator.readyState !== room.creator.OPEN) {
          rooms.delete(code)
          console.log(`[ROOM] JOIN FAIL  ${code}  creator gone  from ${normIp}`)
          send(ws, { type: 'error', message: 'Sala no encontrada' })
          return
        }
        if (room.joiner && room.joiner.readyState === room.joiner.OPEN) {
          console.log(`[ROOM] JOIN FAIL  ${code}  full  from ${normIp}`)
          send(ws, { type: 'error', message: 'Sala llena' })
          return
        }
        room.joiner = ws
        room.mode = 'p2p'
        console.log(`[ROOM] JOINED  ${code}  by ${normIp}`)
        send(ws, { type: 'room-joined', code })
        send(room.creator, { type: 'peer-joined' })

        // Enviar info mutua a ambos clientes (asegurar que ambos reciban self y peer)
        const ci = clientInfo(room.creator)
        const ji = clientInfo(ws)
        // to joiner: self = joiner info, peer = creator info
        send(ws, { type: 'client-info', self: peerSummary(ji), peer: peerSummary(ci) })
        // to creator: self = creator info, peer = joiner info
        send(room.creator, { type: 'client-info', self: peerSummary(ci), peer: peerSummary(ji) })
        // Also send explicit peer-info to the creator for older clients
        send(room.creator, { type: 'peer-info', peer: peerSummary(ji) })
        break
      }

      case 'relay-meta': {
        const info = getPeer(ws)
        console.log(
          `[RELAY] meta  ${info?.code ?? '?'}  type=${msg.payload?.type ?? '?'}  from=${normIp}`
        )
        if (info?.peer) send(info.peer, msg)
        break
      }

      case 'relay-mode': {
        const info = getPeer(ws)
        if (info?.room) info.room.mode = 'relay'
        console.log(`[RELAY] MODE ACTIVATED  room=${info?.code ?? '?'}  from=${normIp}`)
        if (info?.peer) send(info.peer, msg)
        break
      }

      case 'kick-peer': {
        const info = getPeer(ws)
        if (info?.role !== 'creator') return
        if (info?.peer) {
          send(info.peer, { type: 'kicked', reason: 'El dueño de la sala cerró tu conexión.' })
          setTimeout(() => info.peer.close(), 400)
        }
        break
      }

      case 'ban-peer': {
        const info = getPeer(ws)
        if (info?.role !== 'creator') return
        if (!info?.peer) return
        const peerMeta = clientInfo(info.peer)
        // duration: null = permanente, número = segundos
        const duration = msg.duration ?? null
        const until = duration ? new Date(Date.now() + duration * 1000) : null
        bans.set(peerMeta.ip, { until, bannedAt: new Date() })
        const reason = until
          ? `Has sido baneado temporalmente por ${duration} segundos.`
          : 'Has sido baneado permanentemente de este servidor.'
        send(info.peer, { type: 'banned', reason, until: until?.toISOString() ?? null })
        setTimeout(() => info.peer.close(), 400)
        console.log(
          `[Ban] ${peerMeta.ip} baneado — ${until ? `hasta ${until.toISOString()}` : 'permanente'}`
        )
        break
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const info = getPeer(ws)
        console.log(`[RTC]  ${msg.type.padEnd(13)}  room=${info?.code ?? '?'}  from=${normIp}`)
        if (info?.peer) send(info.peer, msg)
        break
      }
    }
  })

  ws.on('close', (code, reason) => {
    const info = getPeer(ws)
    clients.delete(ws)
    console.log(
      `[WS] DISCONNECT  ${normIp}  code=${code}  room=${info?.code ?? '-'}  role=${info?.role ?? '-'}`
    )
    if (!info) return
    const { code: roomCode, room, role, peer } = info
    if (peer) send(peer, { type: 'peer-disconnected' })
    if (role === 'creator') {
      rooms.delete(roomCode)
      return
    }
    room.joiner = null
    room.mode = 'p2p'
  })
})

const PORT = process.env.PORT || 3002
server.listen(PORT, () => {
  console.log(`fAir Drop corriendo en http://localhost:${PORT}`)
  console.log(`Status en         http://localhost:${PORT}/status`)
})
