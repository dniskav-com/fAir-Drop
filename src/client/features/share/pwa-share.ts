// PWA Web Share Target: registra el service worker y drena los archivos
// que llegan por "Compartir → fAir Drop" (Android). El SW guarda el POST
// de /share-target en Cache API; aquí lo pedimos y borramos.
//
// Nota: iOS no soporta share_target (Safari no lo implementa); allí el
// camino sigue siendo el selector de archivos o el pegado.

type SharedFilePayload = { name: string; type: string; blob: Blob }

export function initPwaShare(onFiles: (files: File[]) => void): void {
  if (!('serviceWorker' in navigator)) return

  navigator.serviceWorker.register('/sw.js').catch(() => undefined)

  function drain(): void {
    const sw = navigator.serviceWorker.controller
    if (!sw) return
    const channel = new MessageChannel()
    channel.port1.onmessage = (e: MessageEvent) => {
      const list: SharedFilePayload[] = (e.data as { files?: SharedFilePayload[] })?.files ?? []
      if (list.length) {
        const files = list.map(
          (f) => new File([f.blob], f.name, { type: f.type || 'application/octet-stream' }),
        )
        onFiles(files)
      }
    }
    sw.postMessage('take-shared', [channel.port2])
  }

  // Drenar en cuanto el SW controle la página...
  navigator.serviceWorker.ready.then(() => drain())
  // ...y cuando la página vuelva a primer plano (redirect del share) o
  // al enfocar de nuevo (por si el SW terminó de limpiar entre tanto).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') drain()
  })
  window.addEventListener('focus', drain)
}
