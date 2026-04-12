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
- Modo oscuro (por defecto) con toggle sol/luna. Persiste en `localStorage`.
- Internacionalizacion: español, ingles, frances y aleman. Detecta el idioma del navegador automaticamente. Persiste en `localStorage`.
- Pagina de estado en `/status`.

## Stack

- Node.js
- Express
- ws
- qrcode
- TypeScript (cliente)
- React 18
- Vite
- WebRTC en el navegador

## Ejecutar

Instala dependencias:

```bash
npm install
```

Desarrollo local (UI en :3002, backend en :3003):

```bash
bun run dev
```

Compilar para produccion:

```bash
bun run build
```

Produccion (sirve `dist/` en :3002):

```bash
bun start
```

Abre:

```text
http://localhost:3002
```

Estado del servidor:

```text
http://localhost:3002/status
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
index.html                        Entry point de Vite.
src/client/main.ts                Monta App.tsx sobre #root.
src/client/App.tsx                Componente raiz: enruta entre Home y Room, provee tema e i18n.
src/client/components/            Home, Room, FileList, PeersPanel, ThemeToggle, LanguageSelector, BrandMark, RoomCodeInput.
src/client/hooks/                 useTheme (dark mode), useLocale.
src/client/i18n/                  Sistema i18n: LocaleContext, useTranslation, locales (es/en/fr/de).
src/client/app/                   AppState y tipos de UI.
src/client/features/              Vertical slices: connection, rooms, transfer, qr.
src/client/shared/                Tipos de dominio y utilidades compartidas.
src/core/store.ts                 FairDropStore — estado reactivo global.
public/style.css                  Sistema visual con dark mode via tokens CSS.
```

## Notas de diseno

La UI visible usa la marca `fAir Drop`. El paquete y algunos identificadores tecnicos internos conservan `fairdrop` en minusculas porque es mas estable para npm, canales WebRTC y convenciones de codigo.

El CSS usa patrones modernos compatibles con navegadores actuales: `@layer`, `:where()`/`:has()`, `color-mix()`, unidades `dvh`, container queries, `prefers-reduced-motion`, logical properties y `@supports` para fallback progresivo.

La paleta visual se inspira en los colores de sistema actuales de Apple: `systemBlue` (`#007AFF`), `systemGreen` (`#34C759`), `systemRed` (`#FF3B30`), `systemOrange` (`#FF9500`), labels de iOS (`#1C1C1E`, `#3A3A3C`, `#8E8E93`) y fondos agrupados claros (`#F2F2F7`).

UI tweaks:

- Botones: se normalizó la altura y el padding de los botones de la UI para que encajen visualmente con los badges de estado (p. ej. "Esperando..."). Esto mejora la coherencia en la cabecera y en las acciones de la sala.
- Acciones destructivas: se añadió `.btn-destructive` para acciones como "Salir" — estilo con fondo blanco, texto y borde rojos, sin sombra, para seguir el patrón del badge y minimizar ruido visual.

## Limitaciones

- El relay pasa los chunks por el servidor, asi que para archivos grandes consume ancho de banda del host.
- Los bans viven en memoria; se pierden al reiniciar el servidor.
- Las salas viven en memoria; no hay persistencia.
- Para WebRTC fuera de una red simple puede hacer falta TURN. Este proyecto solo configura STUN publico de Google.
- El lector de QR y `BarcodeDetector` requieren contexto seguro (`HTTPS` o `localhost`). Desde `http://IP_LOCAL:3000` usa la app Camara del movil para escanear el QR o entra con codigo/link.
- En produccion la app debe servirse desde HTTPS para aprovechar todas las APIs del navegador. En desarrollo local, `crypto.randomUUID()` no esta disponible en HTTP, pero la app tiene fallback automatico.
