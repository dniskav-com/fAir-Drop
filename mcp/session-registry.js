// Keep recent results queryable without retaining completed sessions forever.
// Active sessions and downloaded files are never removed by this registry.
class SessionRegistry extends Map {
  constructor({ ttlMs = 30 * 60 * 1000, maxCompleted = 100, now = Date.now } = {}) {
    super()
    this.ttlMs = ttlMs
    this.maxCompleted = maxCompleted
    this.now = now
    this.timer = setInterval(() => this.prune(), 60000)
    this.timer.unref()
  }

  prune() {
    const completed = []
    for (const [code, session] of this) {
      if (session.closedAt == null) continue
      if (this.now() - session.closedAt >= this.ttlMs) super.delete(code)
      else completed.push([code, session.closedAt])
    }
    completed.sort((a, b) => a[1] - b[1])
    for (const [code] of completed.slice(0, Math.max(0, completed.length - this.maxCompleted))) super.delete(code)
  }

  get(code) { this.prune(); return super.get(code) }
  set(code, session) { super.set(code, session); this.prune(); return this }
  close() { clearInterval(this.timer) }
}

module.exports = { SessionRegistry }
