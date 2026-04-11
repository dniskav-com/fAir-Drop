# fAir Drop

fAir Drop es una app web para pasar archivos entre dos dispositivos, pensada para usarla en tu red local sin pelearte con AirDrop, cables, nubes ni chats intermedios.

La app crea una sala con un codigo corto. Otro dispositivo entra con ese codigo o con el link compartido, y la transferencia se intenta hacer directo entre navegadores con WebRTC. Si el P2P falla, cambia a modo relay usando el servidor WebSocket.

## Funcionalidades

- Salas temporales con codigo de 4 caracteres.
- Transferencia P2P via WebRTC DataChannel.
- Fallback relay por WebSocket cuando WebRTC no conecta.
- Drag and drop y selector de archivos.
- Soporte movil: camara, galeria y selector de archivos desde Android e iOS.
- Progreso por archivo.
- Expiracion opcional por tiempo.
- Limite opcional de descargas.
- Panel de conexiones con informacion basica del peer.
- QR local para compartir la sala (solo visible para el anfitrion).
- Lector de QR con camara usando `BarcodeDetector` cuando el navegador lo soporta.
- Expulsion y baneo temporal o permanente del invitado.
- Pagina de estado en `/status`.

## Stack

- Node.js
- Express
- ws
- qrcode
- TypeScript (cliente)
- HTML, CSS y JavaScript vanilla
- WebRTC en el navegador

## Ejecutar

Instala dependencias:

```bash
npm install
```

Arranca el servidor (compila y sirve):

```bash
npm start
```

Solo compilar cliente TypeScript:

```bash
npm run build
```

Servidor sin recompilar:

```bash
npm run serve
```

Watch de TypeScript:

```bash
npm run dev
```

Abre:

```text
http://localhost:3000
```

Estado del servidor:

```text
http://localhost:3000/status
```

## Uso en red local

1. Arranca el servidor en el Mac o computadora que hara de host.
2. Busca la IP local del host.
3. Desde otro dispositivo de la misma red abre `http://IP_LOCAL:3000`.
4. Crea una sala en un dispositivo y entra desde el otro con el codigo, link o QR.

En macOS puedes ver tu IP local con:

```bash
ipconfig getifaddr en0
```

## Estructura

```text
server.js                         Servidor Express, WebSocket signaling, salas, relay, QR y status.
src/client/main.ts                Entrada del cliente TypeScript.
src/client/app                    Estado de aplicacion y composicion.
src/client/features               Vertical slices: connection, rooms, transfer, qr, peers y dropzone.
src/client/shared                 Tipos, adaptadores DOM y utilidades compartidas.
public/index.html                 Interfaz principal.
public/style.css                  Tema visual moderno inspirado en AirDrop/macOS.
public/app                        Salida compilada de TypeScript servida al navegador; se regenera con `npm run build`.
```

## Notas de diseno

La UI visible usa la marca `fAir Drop`. El paquete y algunos identificadores tecnicos internos conservan `fairdrop` en minusculas porque es mas estable para npm, canales WebRTC y convenciones de codigo.

El CSS usa patrones modernos compatibles con navegadores actuales: `@layer`, `:where()`/`:has()`, `color-mix()`, unidades `dvh`, container queries, `prefers-reduced-motion`, logical properties y `@supports` para fallback progresivo.

La paleta visual se inspira en los colores de sistema actuales de Apple: `systemBlue` (`#007AFF`), `systemGreen` (`#34C759`), `systemRed` (`#FF3B30`), `systemOrange` (`#FF9500`), labels de iOS (`#1C1C1E`, `#3A3A3C`, `#8E8E93`) y fondos agrupados claros (`#F2F2F7`).

## Limitaciones

- El relay pasa los chunks por el servidor, asi que para archivos grandes consume ancho de banda del host.
- Los bans viven en memoria; se pierden al reiniciar el servidor.
- Las salas viven en memoria; no hay persistencia.
- Para WebRTC fuera de una red simple puede hacer falta TURN. Este proyecto solo configura STUN publico de Google.
- El lector de QR y `BarcodeDetector` requieren contexto seguro (`HTTPS` o `localhost`). Desde `http://IP_LOCAL:3000` usa la app Camara del movil para escanear el QR o entra con codigo/link.
- En produccion la app debe servirse desde HTTPS para aprovechar todas las APIs del navegador. En desarrollo local, `crypto.randomUUID()` no esta disponible en HTTP, pero la app tiene fallback automatico.
