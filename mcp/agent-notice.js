function notice(sessionId, message) {
  return { type: 'message', session_id: sessionId, message_id: message.message_id, sequence: message.sequence, from: { alias: String(message.from?.alias || '').slice(0, 80), endpoint_id: message.from?.endpoint_id }, kind: String(message.kind || '').slice(0, 64), received_at: message.received_at, cursor: String(message.sequence) }
}
module.exports = { notice }
