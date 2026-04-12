import React, { useEffect, useState } from 'react'
import type { AppState } from '../app/state'
import type { PeerInfo, Role } from '../shared/domain/types'
import { elapsed } from '../shared/application/format'

type Actions = { kickPeer(): void; banPeer(duration: number | null): void }

function ClientCard({
  info,
  role,
  isSelf,
  canControl,
  actions,
}: {
  info: PeerInfo
  role: Role
  isSelf: boolean
  canControl: boolean
  actions: Actions
}) {
  const [tick, setTick] = useState(0)
  const [banDur, setBanDur] = useState<number>(60)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <li className={'client-item' + (isSelf ? ' is-self' : '')}>
      <div className="client-role">
        {role === 'creator' ? 'Creador' : 'Invitado'}
        {isSelf ? <span className="you-badge">tu</span> : null}
      </div>
      <div className="client-ip">{info.ip}</div>
      <div className="client-browser">
        <span className="client-icon">{info.mobile ? 'mobile' : 'desktop'}</span> {info.browser}
      </div>
      <div className="client-since">
        {'conectado hace '}
        <span data-since={isSelf ? 'self' : 'peer'}>{elapsed(info.connectedAt)}</span>
      </div>

      {canControl ? (
        <div className="peer-actions">
          <button className="btn-kick" onClick={actions.kickPeer} data-kick-peer>
            Expulsar
          </button>

          <div className="ban-row">
            <button
              className="btn-ban"
              onClick={() => actions.banPeer(null)}
              data-ban-peer="permanent"
            >
              Ban permanente
            </button>
          </div>

          <div className="ban-row">
            <button
              className="btn-ban"
              onClick={() => actions.banPeer(banDur)}
              data-ban-peer="temporary"
            >
              Ban temporal
            </button>
            <input
              type="number"
              className="expiry-input"
              min={1}
              max={86400}
              value={banDur}
              onChange={(e) => setBanDur(Number(e.target.value) || 60)}
            />
            <span className="ban-unit">seg</span>
          </div>
        </div>
      ) : null}
    </li>
  )
}

export default function PeersPanel({ state, actions }: { state: AppState; actions: Actions }) {
  return (
    <ul className="clients-list">
      {!state.selfInfo ? (
        <li className="client-empty">Esperando...</li>
      ) : (
        <>
          <ClientCard
            info={state.selfInfo}
            role={state.isCreator ? 'creator' : 'joiner'}
            isSelf
            canControl={false}
            actions={actions}
          />
          {state.peerInfo ? (
            <ClientCard
              info={state.peerInfo}
              role={state.isCreator ? 'joiner' : 'creator'}
              isSelf={false}
              canControl={state.isCreator}
              actions={actions}
            />
          ) : (
            <li className="client-item is-empty">
              <div className="client-role">{state.isCreator ? 'Invitado' : 'Creador'}</div>
              <div className="client-ip">-</div>
              <div className="client-browser">Sin conectar</div>
            </li>
          )}
        </>
      )}
    </ul>
  )
}
