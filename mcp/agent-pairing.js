const crypto = require('node:crypto')
const { SRP, SrpServer, SrpClient } = require('fast-srp-hap')
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function newPin() { return Array.from(crypto.randomBytes(4), byte => alphabet[byte & 31]).join('') }
function parseCode(value) {
  const normalized = value.toUpperCase().replace(/[\s-]/g, '')
  if (!/^[A-Z0-9]{8}$/.test(normalized)) throw new Error('Agent pairing requires an eight-character code')
  const pairing_pin = normalized.slice(4).replace(/O/g, '0').replace(/[IL]/g, '1')
  if (![...pairing_pin].every(c => alphabet.includes(c))) throw new Error('Invalid pairing code')
  return { code: normalized.slice(0, 4), pairing_pin }
}
function hex(value, bytes) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) throw new Error('Invalid pairing proof')
  return Buffer.from(value, 'hex')
}
class Pairing {
  constructor(meta, creatorNonce, guestNonce) { Object.assign(this, { meta, creatorNonce, guestNonce }) }
  identity() { return Buffer.from(JSON.stringify(['fairdrop-srp6a-v1', this.meta.code, this.conversation_id, this.expires_at, this.creatorNonce, this.guestNonce])) }
  challenge() {
    this.conversation_id = this.meta.conversation_id; this.expires_at = this.meta.expires_at
    const salt = crypto.randomBytes(16)
    this.srp = new SrpServer(SRP.params.hap, salt, this.identity(), Buffer.from(this.meta.pairing_pin), crypto.randomBytes(32))
    return { type: 'agent-pair-challenge', conversation_id: this.conversation_id, expires_at: this.expires_at, salt: salt.toString('hex'), B: this.srp.computeB().toString('hex') }
  }
  answer(p) {
    if (typeof p.conversation_id !== 'string' || !/^[0-9a-f-]{36}$/.test(p.conversation_id) || !Number.isSafeInteger(p.expires_at) || p.expires_at <= Date.now() || p.expires_at > Date.now() + 86400000) throw new Error('Invalid pairing session')
    this.conversation_id = p.conversation_id; this.expires_at = p.expires_at
    this.srp = new SrpClient(SRP.params.hap, hex(p.salt, 16), this.identity(), Buffer.from(this.meta.pairing_pin), crypto.randomBytes(32))
    this.srp.setB(hex(p.B, 384))
    return { type: 'agent-pair-proof', A: this.srp.computeA().toString('hex'), proof: this.srp.computeM1().toString('hex') }
  }
  verify(p) {
    this.srp.setA(hex(p.A, 384)); this.srp.checkM1(hex(p.proof, 64))
    this.verified = true
    return { type: 'agent-pair-confirm', proof: this.srp.computeM2().toString('hex') }
  }
  confirm(p) { this.srp.checkM2(hex(p.proof, 64)); this.verified = true }
  config() {
    if (!this.verified) throw new Error('Pairing not authenticated')
    const secret = Buffer.from(crypto.hkdfSync('sha256', this.srp.computeK(), Buffer.alloc(0), this.identity(), 32)).toString('base64url')
    return { secret, conversation_id: this.conversation_id, expires_at: this.expires_at, pairing_pin: null, paired: true }
  }
}
module.exports = { Pairing, newPin, parseCode }
