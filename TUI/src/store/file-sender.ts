import * as fs from 'fs'
import * as path from 'path'
import { formatBytes, guessMime } from '../utils'
import type { AppState, Transfer, CompletedTransfer, ExpiryConfig, LogEntry } from '../types'
import type { ConnectionService } from '../services/connection'

const CHUNK_SIZE = 128 * 1024

let _seq = 0
export function genId(): string {
  return `${Date.now().toString(36)}-${(++_seq).toString(36)}`
}

export interface SenderDeps {
  addLog(msg: string, type?: LogEntry['type']): void
  emit(): void
}

export async function sendFile(
  state: AppState,
  connection: ConnectionService,
  filePath: string,
  expiry: ExpiryConfig | undefined,
  deps: SenderDeps
): Promise<void> {
  const { connectionStatus } = state
  if (connectionStatus !== 'relay' && connectionStatus !== 'connected') {
    throw new Error('No hay peer conectado. Espera a que alguien se una.')
  }
  if (!fs.existsSync(filePath)) throw new Error(`Archivo no encontrado: ${filePath}`)

  const name = path.basename(filePath)
  const buf = fs.readFileSync(filePath)
  const size = buf.length
  const totalChunks = Math.ceil(size / CHUNK_SIZE) || 1
  const fileId = genId()

  const t: Transfer = {
    fileId, name, size, totalChunks,
    chunks: [], received: 0, direction: 'sending', startTime: Date.now(),
  }
  state.transfers.set(fileId, t)
  deps.addLog(`Enviando: ${name} (${formatBytes(size)})`, 'info')
  deps.emit()

  connection.send({
    type: 'relay-meta',
    payload: {
      type: 'file-start', fileId, name, size,
      mimeType: guessMime(name), totalChunks,
      ...(expiry && (expiry.time || expiry.downloads) ? { expiry } : {}),
    },
  })

  for (let i = 0; i < totalChunks; i++) {
    const chunk = buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    if (!connection.isOpen()) {
      state.transfers.delete(fileId)
      deps.emit()
      throw new Error('Conexión perdida durante la transferencia')
    }
    connection.sendBinary(chunk)
    const entry = state.transfers.get(fileId)
    if (entry) entry.received = i + 1
    if (i % 20 === 19 || i === totalChunks - 1) {
      deps.emit()
      await new Promise<void>((r) => setImmediate(r))
    }
  }

  connection.send({ type: 'relay-meta', payload: { type: 'file-end', fileId } })

  state.transfers.delete(fileId)
  const completed: CompletedTransfer = {
    fileId, name, size, direction: 'sending', completedAt: Date.now(),
  }
  state.completedTransfers.unshift(completed)
  if (state.completedTransfers.length > 20) state.completedTransfers.length = 20
  deps.addLog(`Enviado: ${name}`, 'success')
  deps.emit()
}
