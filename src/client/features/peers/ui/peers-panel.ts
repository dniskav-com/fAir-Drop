import type { AppState } from '../../../app/state.js';
import type { PeerInfo, Role } from '../../../shared/domain/types.js';
import { elapsed } from '../../../shared/application/format.js';

export function renderClients(
  state: AppState,
  clientsList: HTMLUListElement,
  actions: { kickPeer(): void; banPeer(duration: number | null): void },
): void {
  if (!state.selfInfo) {
    clientsList.innerHTML = '<li class="client-empty">Esperando...</li>';
    return;
  }

  const selfRole: Role = state.isCreator ? 'creator' : 'joiner';
  const peerRole: Role = state.isCreator ? 'joiner' : 'creator';
  let html = clientCard(state.selfInfo, selfRole, true, false);
  html += state.peerInfo
    ? clientCard(state.peerInfo, peerRole, false, state.isCreator)
    : `<li class="client-item is-empty"><div class="client-role">${state.isCreator ? 'Invitado' : 'Creador'}</div><div class="client-ip">-</div><div class="client-browser">Sin conectar</div></li>`;

  clientsList.innerHTML = html;
  clientsList.querySelector<HTMLButtonElement>('[data-kick-peer]')?.addEventListener('click', actions.kickPeer);
  clientsList.querySelector<HTMLButtonElement>('[data-ban-peer="permanent"]')?.addEventListener('click', () => actions.banPeer(null));
  clientsList.querySelector<HTMLButtonElement>('[data-ban-peer="temporary"]')?.addEventListener('click', () => {
    const value = Number((document.getElementById('ban-dur') as HTMLInputElement | null)?.value ?? '60');
    actions.banPeer(value);
  });

  if (state.clientsTimer) window.clearInterval(state.clientsTimer);
  state.clientsTimer = window.setInterval(() => {
    document.getElementById(`since-${selfRole}`)?.replaceChildren(document.createTextNode(elapsed(state.selfInfo?.connectedAt ?? null)));
    if (state.peerInfo) {
      document.getElementById(`since-${peerRole}`)?.replaceChildren(document.createTextNode(elapsed(state.peerInfo.connectedAt)));
    }
  }, 1000);
}

function clientCard(info: PeerInfo, role: Role, isSelf: boolean, canControl: boolean): string {
  const icon = info.mobile ? 'mobile' : 'desktop';
  return `<li class="client-item${isSelf ? ' is-self' : ''}">
    <div class="client-role">
      ${role === 'creator' ? 'Creador' : 'Invitado'}
      ${isSelf ? '<span class="you-badge">tu</span>' : ''}
    </div>
    <div class="client-ip">${info.ip}</div>
    <div class="client-browser">${icon} ${info.browser}</div>
    <div class="client-since">conectado hace <span id="since-${role}">${elapsed(info.connectedAt)}</span></div>
    ${canControl ? `
      <div class="peer-actions">
        <button class="btn-kick" data-kick-peer>Expulsar</button>
        <div class="ban-row">
          <button class="btn-ban" data-ban-peer="permanent">Ban permanente</button>
        </div>
        <div class="ban-row">
          <button class="btn-ban" data-ban-peer="temporary">Ban temporal</button>
          <input id="ban-dur" type="number" class="expiry-input" min="1" max="86400" value="60" />
          <span class="ban-unit">seg</span>
        </div>
      </div>` : ''}
  </li>`;
}
