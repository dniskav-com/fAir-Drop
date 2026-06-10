# Desarrollo — Progreso y notas

## 2026-04-12

### Resuelto

- Fix WebSocket proxy: las variables de entorno del script `dev` solo aplicaban a `node server.js` y no a `vite`. Corregido separando los prefijos: `PORT=3003 node server.js & SERVER_PORT=3003 VITE_PORT=3002 vite`.
- Dark mode estilo Apple con toggle sol/luna. Persiste en `localStorage` (`fairdrop-theme`). Por defecto oscuro.
- Coherencia de dark mode: eliminados todos los `background: white` y `rgb(255 255 255 / ...)` hardcodeados; reemplazados por tokens CSS (`--panel-solid`, `--panel-tint`, etc.).
- i18n sin dependencias externas: español, inglés, francés, alemán. Detecta idioma del navegador. Persiste en `localStorage` (`fairdrop-locale`). Selector con banderas en la UI (🇪 ES / 🇬 EN / 🇫 FR / 🇩 DE).
- CI/CD: pipeline de GitHub Actions en `.github/workflows/deploy.yml`. Push a `main` → SSH al VPS → `git pull` + `bun install` + `bun run build` + `pm2 reload fairdrop`. Usa los secrets de organización de GitHub (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`).

### Puertos actuales

- Dev: Vite UI en `:3002`, Express/WS en `:3003`
- Producción (VPS): Express sirve `dist/` en `:3002`

---

## 2026-04-13

### TURN Server — Hallazgos y decisión

- Se configuró TURN con Metered.ca (`global.relay.metered.ca`) para mejorar tasa de éxito P2P fuera de LAN.
- **Problema**: WebRTC elegía el relay TURN incluso cuando había conectividad directa disponible. Resultado: transferencias más lentas y consumo de quota (95 MB en 4 pruebas).
- **Decisión**: Se removieron los servidores TURN. Ahora solo se usan los STUN de Google (`stun.l.google.com`, `stun1.l.google.com`) para descubrimiento de IPs públicas. WebRTC negocia P2P directo; si falla, cae al relay del VPS propio.
- **Lección**: TURN es útil solo cuando ambos peers NO pueden conectar directo (NAT simétrico estricto). Para la mayoría de casos (misma red o redes móviles compatibles), STUN + P2P directo es más rápido y gratis.
- El indicador de tipo de conexión permite verificar si es `(P2P directo)` o `(TURN)`.

### Resuelto

- **Chunk size**: aumentado de 16 KB a 128 KB en `transfer.ts`. Reduce cantidad de mensajes para archivos grandes → transferencias más rápidas.
- **Detección de tipo de conexión**: se agregó `connectionType` al AppState (`'direct' | 'turn' | 'unknown'`). Se inspeccionan los candidatos ICE seleccionados vía `pc.getStats()` para saber si la conexión pasa por TURN (`candidateType === 'relay'`) o es directa.
- **UI**: el badge de estado ahora muestra `(P2P directo)` o `(TURN)` según corresponda.
- **Botón "Reintentar P2P"**: cuando la conexión cae a relay, aparece un botón en el banner naranja para forzar una nueva negociación WebRTC. Útil cuando el usuario cambia de red (ej: WiFi → datos móviles) y quiere reintentar sin salir de la sala.
  - Señal `retry-p2p` enviada vía WebSocket al peer.
  - Ambos lados resetean su estado WebRTC (`pc`, `dc`, `useRelay`).
  - El creador inicia nueva oferta.
  - Traducciones en ES/EN/FR/DE.
- **Dominio**: el dominio correcto es `fair-drop.dniskav.com` (no `fairdrop.dniskav.com`).

### Pendiente / Ideas futuras

- **Paste desde portapapeles**: detectar `Ctrl+V`/`Cmd+V` o botón "Pegar" para enviar imágenes/texto del portapapeles directamente.
- **HTTPS en desarrollo local** con `mkcert` para paridad con producción (permite `BarcodeDetector` y `crypto.randomUUID()` nativos).
- **Eliminar `src/client/core/store.ts`** (duplicado incompleto); el store activo es `src/core/store.ts`.
