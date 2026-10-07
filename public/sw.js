// Service worker de fAir Drop.
// Responsabilidad: capturar compartidos del SO vía Web Share Target
// (manifest.webmanifest → action "/share-target"), guardarlos en Cache API
// y entregarlos a la página cuando la pida ('take-shared').
// Sin persistencia de más: el caché se limpia al entregar y el SW no
// hace cacheo de assets (la app se sirve con LH headers de Caddy).
const CACHE = 'fairdrop-shared'
const META_PREFIX = '/__shared/meta/'
const FILE_PREFIX = '/__shared/f/'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// share_target POST (multipart/form-data): título/texto/url + files
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'POST') return
  const url = new URL(event.request.url)
  if (url.pathname !== '/share-target') return
  event.respondWith(handleShare(event.request))
})

async function handleShare(request) {
  try {
    const form = await request.formData()
    const meta = []
    let i = 0
    for (const item of [/* files */ ...form.getAll('files'), ...form.getAll('file')]) {
      if (!(item instanceof File)) continue
      const key = FILE_PREFIX + Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2)
      const cache = await caches.open(CACHE)
      await cache.put(key, new Response(item, { headers: { 'content-type': item.type } }))
      // Sanear el nombre: viene del SO pero nunca se usa para tocar FS
      const name = String(item.name || ('compartido-' + i)).replace(/[/\\]/g, '_').replace(/\0/g, '')
      meta.push({ key, name, type: item.type })
      i++
    }
    if (meta.length) {
      const cache = await caches.open(CACHE)
      await cache.put(
        META_PREFIX + Date.now(),
        new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }),
      )
    }
    return Response.redirect(new URL('/?shared=1', self.location.origin).href, 303)
  } catch {
    return new Response('bad share payload', { status: 400 })
  }
}

// La página pide los compartidos pendientes: se entregan TODOS y se borra.
self.addEventListener('message', (event) => {
  if (event.data !== 'take-shared') return
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const keys = await cache.keys()
      const metaKeys = keys.filter((r) => new URL(r.url).pathname.startsWith(META_PREFIX))
      const files = []
      const consumed = new Set()
      for (const req of metaKeys) {
        const metaRes = await cache.match(req)
        if (!metaRes) continue
        const meta = await metaRes.json()
        for (const m of meta) {
          const hit = await cache.match(m.key)
          if (!hit) continue
          files.push({ name: m.name, type: m.type, blob: await hit.blob() })
          consumed.add(m.key)
        }
        consumed.add(new URL(req.url).pathname)
      }
      event.ports[0] && event.ports[0].postMessage({ files })
      await Promise.all([...consumed].map((k) => cache.delete(k)))
    })(),
  )
})
