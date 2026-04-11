# AGENTS.md

## Proyecto

fAir Drop es una app local-first para compartir archivos entre dos dispositivos desde el navegador. La intencion del producto es ser un guino practico a AirDrop para casos donde compartir archivos entre computadoras en casa resulta incomodo.

## Como trabajar en este repo

- Mantener la app simple: Node.js, Express, `ws`, TypeScript de navegador, HTML/CSS vanilla.
- No introducir frameworks frontend salvo que el usuario lo pida explicitamente.
- Preservar los IDs de `public/index.html`; `src/client/main.ts` y sus slices dependen de ellos via `getDomRefs()` — si falta un ID la app no arranca.
- La fuente del cliente vive en `src/client`; no editar a mano `public/app/`, porque es salida de esbuild y se regenera con `npm run build`.
- Mantener `fairdrop` como identificador tecnico interno cuando aplique, aunque la marca visible sea `fAir Drop`.
- Evitar persistencia innecesaria: salas, clientes y bans estan en memoria por diseno.
- El build script actualiza automaticamente el query string de version en `public/index.html` para evitar cache en los navegadores de desarrollo.

## Comandos

```bash
npm install
npm run build    # compila TypeScript y actualiza ?v= en index.html
npm start        # build + node server.js
npm run dev      # watch de TypeScript
npm run serve    # solo servidor sin compilar
node --check server.js
```

## Arquitectura

`server.js` sirve archivos estaticos, mantiene salas en memoria y actua como signaling WebSocket para WebRTC. Tambien reenvia metadatos y chunks binarios cuando la app cae a modo relay.

`src/client/main.ts` compone la experiencia del navegador: creacion/union a sala, handshake WebRTC, DataChannel, fallback relay, drag and drop, progreso de archivos, expiraciones, eliminacion remota y controles del peer.

La estructura TypeScript sigue una version ligera de arquitectura hexagonal con vertical slicing:

```text
src/client/app                         estado y composicion
src/client/shared/domain               tipos del dominio del cliente
src/client/shared/adapters             adaptadores DOM
src/client/shared/application          utilidades sin DOM
src/client/features/connection         WebSocket, signaling, WebRTC y relay
src/client/features/rooms              crear/unirse/resetear sala
src/client/features/transfer           archivos, chunks, expiraciones
src/client/features/dropzone           UI del dropzone
src/client/features/peers              panel de conexiones
src/client/features/qr                 escaner QR
```

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

- El orden de chunks en relay asume una transferencia activa por flujo de recepcion; probar bien si se agregan envios paralelos reales.
- `URL.createObjectURL` debe revocarse al borrar archivos para evitar leaks.
- Las expiraciones deben avisar al peer con `file-deleted` para mantener ambas listas sincronizadas.
- La pagina `/status` esta embebida en `server.js`; si se rediseña, mantenerla ligera.
- El cliente agrega clases `is-mobile` / `is-desktop` al documento usando pointer coarse y user agent.
- El servidor conserva la sala cuando se desconecta el invitado; solo borra la sala cuando se va el creador.
- El bundle `public/app/main.js` ronda 1MB por las dependencias de React incluidas en el tree (aunque React no se monta en la UI actual). Si se decide descartar React definitivamente, eliminar las dependencias reduce el bundle.

## Estilo visual

La UI debe sentirse cercana a macOS/AirDrop: clara, precisa, con vidrio sutil, radar central y controles compactos. Mantener radios pequenos, buena legibilidad y layout estable en movil.

Usar como base los colores de sistema de Apple: `#007AFF`, `#34C759`, `#FF3B30`, `#FF9500`, grises de label (`#1C1C1E`, `#3A3A3C`, `#8E8E93`) y fondo agrupado claro (`#F2F2F7`).

No convertir la pantalla inicial en una landing de marketing; la primera pantalla debe seguir siendo util: crear sala o unirse.

## Estado actual

La app funciona en modo vanilla (HTML/CSS/TypeScript sin frameworks en runtime). Los archivos React (`src/client/App.tsx`, `src/client/components/`) existen en el repo como trabajo en progreso de una migracion pendiente, pero no se montan en la UI actual.

## Proximos pasos sugeridos

- Decidir si la migracion a React continua o se descarta. Si se descarta, eliminar `App.tsx`, `components/` y las dependencias `react`/`react-dom` para reducir el bundle.
- Anadir TURN server para casos de WebRTC fuera de red local simple.
- Evaluar servir la app con HTTPS en desarrollo local (mkcert) para tener paridad de entorno con produccion.

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
  apps: [{
    name: 'fairdrop',
    script: 'server.js',
    env: {
      PORT: 3001,
      NODE_ENV: 'production'
    }
  }]
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
