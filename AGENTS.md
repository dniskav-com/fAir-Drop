# AGENTS.md

## Proyecto

fAir Drop es una app local-first para compartir archivos entre dos dispositivos desde el navegador. La intencion del producto es ser un guino practico a AirDrop para casos donde compartir archivos entre computadoras en casa resulta incomodo.

## Como trabajar en este repo

- Mantener la app simple: Node.js, Express, `ws`, TypeScript de navegador, HTML/CSS vanilla.
- No introducir frameworks frontend salvo que el usuario lo pida explicitamente.
- Preservar los IDs de `public/index.html`; `src/client/main.ts` y sus slices dependen de ellos.
- La fuente del cliente vive en `src/client`; no editar a mano `public/app/`, porque es salida de `tsc` y esta ignorada por git.
- Mantener `fairdrop` como identificador tecnico interno cuando aplique, aunque la marca visible sea `fAir Drop`.
- Evitar persistencia innecesaria: salas, clientes y bans estan en memoria por diseno.

## Comandos

```bash
npm install
npm run build
npm start
npm run dev
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
6. Si WebRTC falla, ambos clientes activan relay y los chunks pasan por WebSocket.

## Cuidado con

- El orden de chunks en relay asume una transferencia activa por flujo de recepcion; probar bien si se agregan envios paralelos reales.
- `URL.createObjectURL` debe revocarse al borrar archivos para evitar leaks.
- Las expiraciones deben avisar al peer con `file-deleted` para mantener ambas listas sincronizadas.
- El boton de copiar codigo usa texto, no icono, para no romper el layout moderno.
- La pagina `/status` esta embebida en `server.js`; si se rediseña, mantenerla ligera.
- El escaner de QR usa `BarcodeDetector` y requiere contexto seguro (`HTTPS` o `localhost`); mantener fallback por codigo manual y QR visible para leerlo con la app Camara del movil.
- El cliente agrega clases `is-mobile` / `is-desktop` al documento usando pointer coarse y user agent.
- El servidor conserva la sala cuando se desconecta el invitado; solo borra la sala cuando se va el creador.

## Estilo visual

La UI debe sentirse cercana a macOS/AirDrop: clara, precisa, con vidrio sutil, radar central y controles compactos. Mantener radios pequenos, buena legibilidad y layout estable en movil.

Usar como base los colores de sistema de Apple: `#007AFF`, `#34C759`, `#FF3B30`, `#FF9500`, grises de label (`#1C1C1E`, `#3A3A3C`, `#8E8E93`) y fondo agrupado claro (`#F2F2F7`).

No convertir la pantalla inicial en una landing de marketing; la primera pantalla debe seguir siendo util: crear sala o unirse.
