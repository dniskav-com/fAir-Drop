#!/usr/bin/env node
import { Store } from './store'
import { App } from './ui/app'

const PROD_URL = 'wss://fair-drop.dniskav.com/ws'
const LOCAL_URL = 'ws://localhost:3002/ws'

const args = process.argv.slice(2)
const arg0 = args[0]

function resolveServerUrl(): string {
  if (!arg0) return process.env.FAIRDROP_SERVER ?? LOCAL_URL
  if (arg0 === '--remote' || arg0 === 'remote' || arg0 === '-r') return PROD_URL
  if (arg0 === '--local' || arg0 === 'local' || arg0 === '-l') return LOCAL_URL
  return arg0
}

const serverUrl = resolveServerUrl()

const store = new Store(serverUrl)
const app = new App(store)

process.on('uncaughtException', (err) => {
  // Avoid crashing on blessed render issues
  if (String(err).includes('Cannot read') || String(err).includes('blessed')) return
  process.stderr.write(`[fAir Drop TUI] ${err.message}\n`)
})

process.on('SIGINT', () => {
  store.destroy()
  app.destroy()
  process.exit(0)
})

process.on('SIGTERM', () => {
  store.destroy()
  app.destroy()
  process.exit(0)
})
