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
- Internazionalizacion: español, ingles, frances y aleman. Detecta el idioma del navegador automaticamente. Persiste en `localStorage`.
- API de estado `/api/status`: publico devuelve metricas agregadas; el detalle completo requiere token de administrador (`x-admin-token`). Ver `AGENTS.md`.
- **Servidor MCP** (`mcp/`) para que agentes de IA envien archivos del servidor a una persona por consola (ver "Para agentes IA" abajo).

## Stack

- Node.js
- Express
- ws
- qrcode
- TypeScript (cliente)
- React 18
- Vite
- WebRTC en el navegador
- MCP SDK (servidor MCP para agentes)

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
3. Desde otro dispositivo de la misma red abre `http://IP_LOCAL:3002`.
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
mcp/                              Servidor MCP para agentes de IA (envio headless de archivos).
TUI/                              Cliente de terminal experimental (Node + blessed + ws).
```

## Para agentes IA (servidor MCP)

fAir Drop incluye un servidor MCP que permite a un agente de IA (OpenCode,
Claude, etc.) enviar archivos desde la maquina donde corre el servidor hacia
una persona, sin UI y sin scp:

```bash
cd mcp && bun install    # instalar dependencias (ws, @modelcontextprotocol/sdk, zod)
node mcp/index.js        # arranca por stdio
```

Tools que expone:

| Tool | Descripcion |
|---|---|
| `fairdrop_create_session` | Crea la sala y devuelve el codigo de 4 caracteres al instante. Recibe rutas absolutas (max. 10 archivos). |
| `fairdrop_session_status` | Estado de la sesion: `waiting` (esperando al usuario), `sent` (archivos enviados, pendiente de confirmar descarga), `error`, etc. |
| `fairdrop_status` | Metricas publicas del servidor (salas, clientes, uptime). |

Flujo recomendado: crear sesion → darle el codigo al usuario ("entra en
https://fair-drop.dniskav.com con el codigo XXXX") → consultar estado hasta
`sent`. La sala expira a los 15 minutos si nadie entra.

El MCP corre por stdio local y habla el mismo protocolo de relay que la TUI
(sala via WSS, `relay-mode`, `file-start` + chunks binarios de 128 KB +
`file-end`), asi que no anade ninguna superficie publica nueva. Ver detalles
y el bug de `ws.on('open')` documentado en `AGENTS.md`.

Registro en OpenCode (global):

```json
{
  "mcp": {
    "servers": {
      "fairdrop": {
        "type": "local",
        "command": ["node", "/ruta/a/fAir-Drop/mcp/index.js"]
      }
    }
  }
}
```

## Cliente de terminal (TUI)

Existe un cliente experimental de terminal en `TUI/` (Node + `blessed`) que
usa el mismo servidor de senalizacion y envia archivos en modo relay. Ver
`AGENTS.md` para estado, limitaciones y notas de seguridad.

## Seguridad

- Autenticacion por API key opcional en endpoints de estado; rate limiting
  en creacion de salas (20/IP cada 15 min) y generacion de QR (60/min).
- Los nombres de archivo que llegan por el canal se sanitizan antes de
  escribir en disco (path traversal corregido en `TUI/src/store.ts`).
- Cabeceras de seguridad aplicadas en el proxy del despliegue
  (`Permissions-Policy: camera=(self)` en el subdominio, necesario para el
  escaner QR).
- Detalles de la auditoria completa y decisiones de diseno de seguridad:
  ver `AGENTS.md`.

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
