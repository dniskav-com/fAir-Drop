# AGENTS.md

## Proyecto

fAir Drop es una app local-first para compartir archivos entre dos dispositivos desde el navegador. La intencion del producto es ser un guino practico a AirDrop para casos donde compartir archivos entre computadoras en casa resulta incomodo.

## Como trabajar en este repo

- Mantener la app simple: Node.js, Express, `ws`, TypeScript de navegador, React sin SSR.
- **La migración a React está activa y es la UI en producción.** El entry point es `src/client/main.ts` que monta `App.tsx` sobre `<div id="root">`. La version vanilla (`main.ts` original) ya no se usa como UI activa.
- El entry point HTML es `index.html` en la raiz del proyecto (no en `public/`). Solo necesita `<div id="root">` — los IDs del HTML vanilla ya no son necesarios en la UI React.
- La fuente del cliente vive en `src/client`. No editar `dist/` ni `public/app/` a mano; son salida de build.
- `public/` es el `publicDir` de Vite: solo contiene `style.css`. No poner ahi archivos compilados.
- Mantener `fairdrop` como identificador tecnico interno cuando aplique, aunque la marca visible sea `fAir Drop`.
- Evitar persistencia innecesaria: salas, clientes y bans estan en memoria por diseno.
- Vite maneja cache busting automaticamente en build (hashes en nombres de assets).
- El store reactivo vive en `src/core/store.ts` (no en `src/client/core/`). `App.tsx` importa de `'../core/store'`.

## Comandos

```bash
bun install
bun run dev        # Vite UI :3002 + Express/WS :3003 en paralelo
bun run build      # vite build → dist/
bun start          # NODE_ENV=production node server.js (sirve dist/ en :3002)
bun run typecheck  # tsc --noEmit (solo chequeo de tipos)
node --check server.js
```

## Arquitectura

`server.js` corre en el puerto 3001 (configurable con `PORT`). En produccion sirve los archivos estaticos desde `dist/`. Mantiene salas en memoria y actua como signaling WebSocket para WebRTC en el path `/ws`. Tambien reenvia metadatos y chunks binarios cuando la app cae a modo relay.

`index.html` (raiz del proyecto) es el entry point de Vite. El script apunta a `/src/client/main.ts` en desarrollo; Vite lo reemplaza por el bundle hasheado en `dist/` al compilar.

`src/client/main.ts` monta `App.tsx` sobre `#root`. Toda la logica de UI vive en los componentes React.

**El unico ID requerido en el HTML es `root`** (el `<div>` donde React monta). Los IDs del HTML vanilla ya no aplican.

**NO existe** `btn-create` — crear sala lo hace el componente `BrandMark` (el radar) a traves de `actions.createRoom()`.

La estructura TypeScript sigue una version ligera de arquitectura hexagonal con vertical slicing:

```text
src/core/store.ts                      FairDropStore — estado global reactivo (unica instancia en App.tsx)
src/client/main.ts                     entry point: monta App.tsx sobre #root
src/client/App.tsx                     componente raiz, provee LocaleProvider, enruta entre Home y Room
src/client/adapters/react/             useFairDrop hook (useSyncExternalStore)
src/client/components/                 Home, Room, FileList, PeersPanel, BrandMark, RoomCodeInput,
                                       ThemeToggle, LanguageSelector
src/client/hooks/useTheme.ts           dark mode con localStorage (clave: fairdrop-theme)
src/client/i18n/index.ts              LocaleProvider + useTranslation hook (React Context)
src/client/i18n/types.ts              interfaz Translations tipada
src/client/i18n/locales/              es.ts, en.ts, fr.ts, de.ts
src/client/app/                        AppState, createAppState, AppPorts
src/client/shared/domain/             tipos del dominio (SignalMessage, ExpiryConfig…)
src/client/shared/application/        utilidades sin DOM (format, etc.)
src/client/features/connection/       WebSocket signaling + WebRTC + relay
src/client/features/rooms/            showRoom, resetToHome
src/client/features/transfer/         sendFiles, handleChunk, deleteFile, expiraciones
src/client/features/qr/               qr-scanner (BarcodeDetector)
```

**Separacion importante:** las features son funciones puras que reciben `(state: AppState, ...args, notify: () => void)`. No tocan el DOM ni React directamente. El store las orquesta.

`public/style.css` contiene el sistema visual. Esta organizado con `@layer` y usa CSS moderno con fallbacks progresivos.

`server.js` tambien expone `/api/qr?text=...`, que devuelve un SVG generado localmente con `qrcode`.

## Flujo de transferencia

1. El creador envia `create-room`.
2. El servidor crea un codigo y espera un invitado.
3. El invitado envia `join-room`.
4. El servidor conecta ambos sockets y reenvia offer/answer/ICE.
5. Si WebRTC conecta, los archivos viajan por DataChannel.
6. Si WebRTC falla o se desconecta, ambos clientes activan relay y los chunks pasan por WebSocket.

## Comportamiento movil

- En iOS y Android el evento `touchend` con `preventDefault()` se usa en los botones principales para evitar que el teclado virtual descarte el tap antes de procesarlo.
- En Android Chrome, el evento `change` del file input no siempre se dispara al volver de la camara. Se usa un listener de `visibilitychange` como fallback para detectar archivos seleccionados al recuperar el foco.
- `crypto.randomUUID()` solo esta disponible en contextos seguros (HTTPS o localhost). En HTTP (desarrollo local) se usa un generador UUID manual como fallback automatico. En produccion (HTTPS) se usa la API nativa.

## Comportamiento del QR

- El QR de sala solo se muestra al anfitrion (creador). Los invitados no lo ven.
- El lector de QR usa `BarcodeDetector` y requiere contexto seguro; en HTTP el usuario debe usar la app Camara del movil para escanear el QR o entrar con codigo/link directamente.

## Cuidado con

- **`notify()` en `FairDropStore` NO reemplaza `_state`**. Crea un `_snap` nuevo para React pero `_state` es siempre la misma referencia. Esto es intencional: los callbacks WebRTC asincronos (`ondatachannel`, `onopen`) capturan `state` por referencia al inicio y deben seguir apuntando al objeto correcto aunque React haya renderizado. Si se cambia `notify()` para reemplazar `_state` se rompe el DataChannel del guest (invitado). Ver bug arreglado abajo.
- El orden de chunks en relay asume una transferencia activa por flujo de recepcion; probar bien si se agregan envios paralelos reales.
- `URL.createObjectURL` debe revocarse al borrar archivos para evitar leaks.
- Las expiraciones deben avisar al peer con `file-deleted` para mantener ambas listas sincronizadas.
- La pagina `/status` esta embebida en `server.js`; si se rediseña, mantenerla ligera.
- El cliente agrega clases `is-mobile` / `is-desktop` al documento usando pointer coarse y user agent.

## Ajustes recientes de UI

- Los botones en la cabecera y acciones se han reducido para empatar visualmente con el badge de estado (`Esperando...`). Ahora los controles usan una altura fija pequeña y padding reducido para mantener una línea visual compacta.
- Se introdujo la clase `.btn-destructive` para acciones peligrosas como "Salir": fondo blanco/panel, texto en `--red` y borde rojo (sin sombra) siguiendo el patrón de los badges.
- `btn-icon` y botones secundarios fueron ajustados para compartir la misma altura y alineación vertical con los badges.

- El servidor conserva la sala cuando se desconecta el invitado; solo borra la sala cuando se va el creador.
- En modo relay, `sendFile` activa `state.useRelay = true` automaticamente si `dc` no esta abierto pero `ws` si. Esto permite al host enviar sin P2P cuando hay NAT restrictivo.
- Cuando la app usa relay en vez de P2P directo, se muestra un banner naranja en `Room.tsx` (clase `.relay-warning`).

## Estilo visual

La UI debe sentirse cercana a macOS/AirDrop: oscura por defecto, precisa, con vidrio sutil, radar central y controles compactos. Mantener radios pequenos, buena legibilidad y layout estable en movil.

Usar como base los colores de sistema de Apple: `#007AFF`, `#34C759`, `#FF3B30`, `#FF9500`, grises de label (`#1C1C1E`, `#3A3A3C`, `#8E8E93`) y fondo agrupado claro (`#F2F2F7`).

El dark mode se controla con la clase `dark` en `<html>`. Los tokens CSS estan en `@layer tokens` dentro de `public/style.css`. Todos los colores deben usar variables (`--ink`, `--panel-solid`, etc.) — nunca `white` o `rgb(255 255 255 / ...)` hardcodeados.

No convertir la pantalla inicial en una landing de marketing; la primera pantalla debe seguir siendo util: crear sala o unirse.

## i18n

El sistema de traducciones es ligero y sin dependencias externas. Funciona con React Context (`LocaleContext`) y el hook `useTranslation()`. Los idiomas soportados son `es`, `en`, `fr`, `de`. La deteccion automatica usa `navigator.language`; la preferencia persiste en `localStorage` con la clave `fairdrop-locale`. Para añadir un idioma: crear `src/client/i18n/locales/xx.ts` implementando la interfaz `Translations`, e importarlo en `src/client/i18n/index.ts`.

## Estado actual

La app funciona con React. `App.tsx` monta `Home` o `Room` segun `state.screen`. El store (`src/core/store.ts`) es la unica fuente de verdad; React lee via `useSyncExternalStore`.

### Bugs arreglados (historico para no repetir)

**DataChannel null en el guest (invitado no podia enviar archivos)**

- Causa: `notify()` hacia `this._state = { ...this._state }`. Los callbacks WebRTC asincronos (`ondatachannel`, `onopen`) capturaban la referencia vieja. `state.dc = channel` se escribia en el objeto abandonado; `_state.dc` quedaba null. El creator no tenia el problema porque `dc` se asigna sincronamente.
- Fix: `_state` es ahora inmutable como referencia (nunca se reemplaza). `notify()` solo reemplaza `_snap`, que es lo que React lee. Las features leen y mutan siempre `_state` directamente.

**Sala zombie al recargar pagina (especialmente en iOS/Android)**

- Causa: iOS/Android puede mantener el WebSocket vivo varios segundos tras recargar. El servidor recibia `peer-joined` y lo reenviaba al creator original que ya no procesaba mensajes, dejando el handshake WebRTC colgado.
- Fix: `beforeunload` llama a `store.disconnect()` que cierra el WebSocket limpiamente. El servidor recibe el evento `close` y elimina la sala de inmediato.

**`getState` perdia `this` en `useSyncExternalStore`**

- Causa: `getState()` era un metodo normal. `useSyncExternalStore` lo llama sin receptor en strict mode → `this` undefined.
- Fix: convertido a arrow function class field.

**Host no podia enviar cuando P2P falla por NAT**

- Causa: `sendFile` lanzaba `no-transport` si `dc` no estaba abierto, incluso si el WebSocket al servidor estaba disponible.
- Fix: fallback automatico a relay si `ws.readyState === OPEN`. Se activa `state.useRelay = true` y se envia por WebSocket. Se muestra banner de aviso en Room.

## Proximos pasos sugeridos

- Anadir TURN server para mejorar tasa de exito P2P fuera de LAN (Metered.ca tiene tier gratuito). Ver seccion TURN en este archivo.
- Evaluar servir la app con HTTPS en desarrollo local (mkcert) para paridad con produccion.
- Eliminar `src/client/core/store.ts` (duplicado incompleto); el store activo es `src/core/store.ts`.

---

## Despliegue en produccion (Hetzner VPS + Cloudflare + Caddy)

### Contexto

- El dominio esta en Cloudflare.
- El VPS esta en Hetzner con Caddy como proxy inverso.
- `dniskav.com` ya corre otro servicio (Vite) en el puerto 3000.
- fAir Drop debe correr en el puerto 3001 bajo el subdominio `fairdrop.dniskav.com`.

### 1. Clonar y preparar

```bash
git clone <repo> fairdrop
cd fairdrop
npm install
npm run build
```

### 2. Archivo de configuracion de pm2

Crear `ecosystem.config.js` en la raiz del proyecto:

```js
module.exports = {
  apps: [
    {
      name: 'fairdrop',
      script: 'server.js',
      env: {
        PORT: 3001,
        NODE_ENV: 'production'
      }
    }
  ]
}
```

### 3. Arrancar con pm2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # ejecutar el comando que devuelva este para que arranque al reiniciar
```

Comandos utiles:

```bash
pm2 logs fairdrop
pm2 restart fairdrop
pm2 list
```

### 4. Configurar Caddy

Anadir al Caddyfile existente:

```
fairdrop.dniskav.com {
    reverse_proxy localhost:3001
}
```

Recargar Caddy:

```bash
caddy reload --config /etc/caddy/Caddyfile
```

### 5. Cloudflare

Crear un registro DNS tipo A para `fairdrop.dniskav.com` apuntando a la IP del VPS.

Dos opciones para el proxy:

- **Nube gris (recomendado para WebSocket)**: Caddy gestiona el certificado HTTPS. WebSocket funciona sin configuracion extra.
- **Nube naranja**: Activar WebSockets en Cloudflare (Dashboard → Network → WebSockets). Si hay problemas de conexion, cambiar a nube gris.

### 6. Firewall en Hetzner

Asegurarse de que los puertos 80 y 443 estan abiertos en el firewall del VPS. El puerto 3001 no necesita estar abierto publicamente — solo Caddy accede a el internamente.

### Consideraciones de seguridad y ancho de banda

- Sin autenticacion: cualquiera con la URL puede usar la app. Considerar IP allowlist en Caddy si es uso personal.
- El relay WebSocket pasa los archivos por el VPS cuando WebRTC P2P falla. En internet (fuera de LAN) el P2P falla con mas frecuencia que en local. Monitorear el consumo de ancho de banda.
- Para reducir uso de relay, anadir un servidor TURN externo (Metered.ca tiene tier gratuito). Ver seccion TURN mas abajo.
- El rate limiting ya esta aplicado en `server.js`. Ver seccion Rate limiting mas abajo.

### TURN server (reducir consumo de relay)

Sin TURN, cuando dos peers en internet no pueden conectar P2P (NAT simetrico), el trafico pasa por el relay WebSocket del VPS. Un servidor TURN externaliza ese trafico.

**Opcion recomendada: Metered.ca** (tier gratuito ~50GB/mes)

1. Crear cuenta en metered.ca y obtener las credenciales TURN.
2. En `src/client/features/connection/application/webrtc.ts`, reemplazar `ICE_SERVERS`:

```typescript
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:TU_SUBDOMINIO.metered.live:80',
    username: 'TU_USERNAME',
    credential: 'TU_CREDENTIAL'
  },
  {
    urls: 'turn:TU_SUBDOMINIO.metered.live:443',
    username: 'TU_USERNAME',
    credential: 'TU_CREDENTIAL'
  },
  {
    urls: 'turns:TU_SUBDOMINIO.metered.live:443',
    username: 'TU_USERNAME',
    credential: 'TU_CREDENTIAL'
  }
]
```

3. Hacer `npm run build` y reiniciar el servidor.

Las credenciales TURN son publicas en el bundle del cliente — es el comportamiento normal de WebRTC. No son credenciales de tu servidor, solo del servicio TURN.

### Rate limiting

Ya aplicado en `server.js`. Los limites actuales son:

- **Crear/unirse a sala**: 20 peticiones por IP cada 15 minutos.
- **API QR**: 60 peticiones por IP cada minuto.

Si necesitas ajustar los limites, busca `rateLimit` en `server.js`.
