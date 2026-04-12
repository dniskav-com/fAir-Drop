/**
 * Hook React para FairDropStore.
 *
 * Uso:
 *   const { state, store } = useFairDrop(storeInstance)
 *
 * `state` es reactivo: React re-renderiza cuando el store emite notify().
 * `store` da acceso directo a las acciones (createRoom, sendFiles, etc.).
 *
 * Ejemplo completo:
 *   // En el punto de entrada React (no en main.ts vanilla)
 *   const store = new FairDropStore()
 *
 *   function App() {
 *     const { state, store } = useFairDrop(store)
 *     return state.screen === 'home'
 *       ? <Home onCreateRoom={() => store.createRoom()} />
 *       : <Room state={state} store={store} />
 *   }
 */

import { useSyncExternalStore } from 'react'
import type { FairDropStore, AppState } from '@core/store'

export function useFairDrop(store: FairDropStore): {
  state: Readonly<AppState>
  store: FairDropStore
} {
  const state = useSyncExternalStore(store.subscribe, store.getState)

  return { state, store }
}
