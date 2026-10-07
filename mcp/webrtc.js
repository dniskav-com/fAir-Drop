// WebRTC nativo (node-datachannel) para el MCP de fAir Drop.
// Interopera con el cliente del navegador usando el mismo signaling:
//   {type:'offer'|'answer', sdp:{type,sdp}}  y  {type:'ice-candidate', candidate:{candidate,sdpMid,...}}
// Reglas de rol igual que en la web:
//   - creador de la sala: crea el DataChannel y lanza la offer
//   - invitado: responde answer y acepta el canal entrante
// Si el DC no abre en OPEN_TIMEOUT_MS, se llama onFail() para caer a relay.
//
// Sin TURN (mismo criterio que la web): STUN público para cross-network;
// si el NAT es demasiado estricto, el fallback es el relay WS del servidor.

const nodeDatachannel = require('node-datachannel')

const OPEN_TIMEOUT_MS = 8 * 1000
const ICE_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']

const DEBUG = process.env.FAIRDROP_WEBRTC_DEBUG === '1'
function dlog(...args) {
  if (DEBUG) process.stderr.write('[webrtc] ' + args.join(' ') + '\n')
}

function normalizeCandidate(c) {
  const raw = typeof c === 'string' ? c : (c && c.candidate)
  if (!raw || typeof raw !== 'string') return null
  return raw.startsWith('candidate:') ? raw : 'candidate:' + raw
}

/**
 * Crea una conexión WebRTC interop con el navegador.
 *
 * onOpen():        el DataChannel está abierto (aún puede fallar en "failed")
 * onString(str):   mensaje de texto del par (meta JSON en la práctica)
 * onBinary(Buffer): chunk binario del par
 * onSend(msg):     dónde emitir señalización (offer/answer/ice-candidate)
 * onFail(reason):  se agotó el timeout de apertura
 *
 * Devuelve { send(str), sendBinary(Buffer), close() }
 */
function initChannel({ role, onOpen, onString, onBinary, onSend, onFail }) {
  let ch = null
  let opened = false
  let failed = false
  const closeTimerMs = OPEN_TIMEOUT_MS

  const pc = new nodeDatachannel.PeerConnection('fairdrop-' + role + '-' + Date.now(), {
    iceServers: ICE_SERVERS,
  })
  pc.onLocalDescription((sdp, type) => {
    dlog(role, 'onLocalDescription', type)
    onSend({ type, sdp: { type, sdp } })
  })
  pc.onLocalCandidate((cand, mid) => {
    dlog(role, 'onLocalCandidate', String(cand).slice(0, 40))
    onSend({ type: 'ice-candidate', candidate: { candidate: cand, sdpMid: mid ?? '0', sdpMLineIndex: 0 } })
  })
  pc.onStateChange((state) => {
    dlog(role, 'pc state:', state)
    if (state === 'failed' && !opened) {
      failed = true
      onFail('webrtc-failed')
    }
  })

  const openTimer = setTimeout(() => {
    if (!opened && !failed) {
      dlog(role, 'TIMEOUT apertura DC')
      failed = true
      onFail('webrtc-timeout')
    }
  }, closeTimerMs)

  function markOpen() {
    dlog(role, 'DC ABIERTO')
    if (opened || failed) return
    opened = true
    clearTimeout(openTimer)
    onOpen()
  }

  function wireChannel(channel) {
    dlog(role, 'datachannel recibida/creada')
    ch = channel
    ch.onOpen(markOpen)
    ch.onClosed(() => {})
    ch.onMessage((msg) => {
      if (typeof msg === 'string') onString(msg)
      else onBinary(Buffer.isBuffer(msg) ? msg : Buffer.from(msg))
    })
  }

  if (role === 'creator') {
    wireChannel(pc.createDataChannel('fairdrop'))
  } else {
    pc.onDataChannel(wireChannel)
  }

  return {
    /** Procesa señalización entrante (offer/answer/ice-candidate) */
    onSignal(msg) {
      if (failed) return
      try {
        dlog(role, 'onSignal', msg.type)
        if (msg.type === 'offer') {
          const desc = typeof msg.sdp === 'string' ? { type: 'offer', sdp: msg.sdp } : msg.sdp
          pc.setRemoteDescription(desc.sdp, desc.type)
        } else if (msg.type === 'answer') {
          const desc = typeof msg.sdp === 'string' ? { type: 'answer', sdp: msg.sdp } : msg.sdp
          pc.setRemoteDescription(desc.sdp, desc.type)
        } else if (msg.type === 'ice-candidate') {
          const cand = normalizeCandidate(msg.candidate)
          if (cand) pc.addRemoteCandidate(cand, (msg.candidate && msg.candidate.sdpMid) || '0')
        }
      } catch (err) {
        dlog(role, 'onSignal ERROR', err && err.message)
      }
    },
    get open() {
      return opened && !failed && !!ch
    },
    send(str) {
      if (opened && ch) ch.sendMessage(String(str))
    },
    sendBinary(buf) {
      if (opened && ch) ch.sendMessageBinary(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    },
    close() {
      clearTimeout(openTimer)
      failed = true
      try {
        if (ch) ch.close()
        pc.close()
      } catch {}
    },
  }
}

module.exports = { initChannel }
