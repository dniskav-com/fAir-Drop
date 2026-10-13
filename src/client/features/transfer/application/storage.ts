import type { ReceiveSink } from '@shared/domain/types'

export const MAX_FILE_BYTES = Number((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_FAIRDROP_MAX_FILE_BYTES || 8 * 1024 ** 3)
const MEMORY_LIMIT = 64 * 1024 ** 2

// Each tab owns a separate directory. Old abandoned transfers are removed after
// 24 hours, without deleting another tab's active files.
let directory: Promise<FileSystemDirectoryHandle> | undefined
async function transferDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!directory) directory = (async () => {
    const root = await navigator.storage.getDirectory()
    const parent = await root.getDirectoryHandle('fairdrop-transfers', { create: true })
    const entries = parent as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }
    for await (const key of entries.keys()) {
      const timestamp = Number(key.split('-')[0])
      if (timestamp > 0 && Date.now() - timestamp > 24 * 60 * 60 * 1000) {
        await parent.removeEntry(key, { recursive: true }).catch(() => undefined)
      }
    }
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return parent.getDirectoryHandle(key, { create: true })
  })().catch(error => { directory = undefined; throw error })
  return directory
}

export async function createReceiveSink(size: number, mimeType: string): Promise<ReceiveSink> {
  if (size <= MEMORY_LIMIT) {
    let chunks: ArrayBuffer[] = []
    return {
      async write(chunk) { chunks.push(chunk) },
      async finish() { const blob = new Blob(chunks, { type: mimeType }); chunks = []; return blob },
      async dispose() { chunks = [] },
    }
  }
  if (!navigator.storage?.getDirectory) throw new Error('Para recibir archivos grandes, usa un navegador actualizado con HTTPS y almacenamiento local disponible.')
  const estimate = await navigator.storage.estimate()
  if (estimate.quota !== undefined && size > estimate.quota - (estimate.usage ?? 0)) throw new Error('No hay suficiente espacio de almacenamiento para recibir este archivo.')
  const folder = await transferDirectory()
  // Never use an untrusted peer's filename as a filesystem path.
  const key = Math.random().toString(36).slice(2) + '-' + Date.now()
  const handle = await folder.getFileHandle(key, { create: true })
  let writer: FileSystemWritableFileStream
  try { writer = await handle.createWritable() } catch (error) {
    await folder.removeEntry(key).catch(() => undefined)
    throw error
  }
  let closed = false
  return {
    async write(chunk) { await writer.write(chunk) },
    async finish() {
      await writer.close()
      closed = true
      // File is backed by disk; never read it back into a giant ArrayBuffer.
      return handle.getFile()
    },
    async dispose() {
      if (!closed) await writer.abort().catch(() => undefined)
      closed = true
      await folder.removeEntry(key).catch(() => undefined)
    },
  }
}
