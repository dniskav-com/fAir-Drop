const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SessionRegistry } = require('./session-registry')

test('expires closed results, bounds history, and preserves active sessions', () => {
  let now = 100
  const sessions = new SessionRegistry({ ttlMs: 100, maxCompleted: 2, now: () => now })
  try {
    sessions.set('LIVE', { state: 'receiving' })
    sessions.set('DONE', { state: 'received', closedAt: 50 })
    sessions.set('ERR1', { state: 'error', closedAt: 60 })
    sessions.set('ERR2', { state: 'error', closedAt: 70 })
    assert.equal(sessions.get('DONE'), undefined)
    assert.equal(sessions.size, 3)
    now = 170
    assert.equal(sessions.get('ERR2'), undefined)
    assert.equal(sessions.size, 1)
    assert.equal(sessions.get('LIVE').state, 'receiving')
  } finally { sessions.close() }
})
