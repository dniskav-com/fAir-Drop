# fAir Drop MCP

Servidor MCP local por stdio, independiente del modelo y de la carpeta de trabajo.
Cada cliente MCP arranca su propio proceso; las sesiones pertenecen a ese proceso.
Los archivos recibidos se guardan en `fAir-Drop/received/session-*` y su ruta
absoluta aparece en `fairdrop_session_status`.

## Codex: configuración global

```sh
codex mcp add fairdrop -- node /root/var/www/fAir-Drop/mcp/index.js
```

Reinicia el cliente o abre una sesión nueva tras configurarlo.

## Otros clientes con soporte MCP stdio

Añade este servidor a la configuración global del cliente (el nombre del
archivo y el formato envolvente dependen del cliente):

```json
{
  "mcpServers": {
    "fairdrop": {
      "command": "node",
      "args": ["/root/var/www/fAir-Drop/mcp/index.js"]
    }
  }
}
```

No requiere ejecutar el cliente dentro de este repositorio. El proceso debe
tener Node.js, acceso de red al signaling y permisos sobre los archivos.
En otro equipo (sin VPS): clona el repo, instala dependencias de `mcp/`
(`bun install` o `npm install`) y apunta `command`/`args` a la ruta local
de `mcp/index.js`. El transporte stdio no es una URL de MCP remoto.

## Herramientas

- `fairdrop_create_session`: enviar hasta diez archivos con rutas absolutas.
- `fairdrop_receive_session`: crear una sala de recepción o unirse a una existente.
- `fairdrop_session_status`: consultar estado y rutas de archivos recibidos.
- `fairdrop_wait_session`: esperar bloqueado hasta que la sesión termine (sent/received/closed/error/expired) con timeout (1–240 s, `timeout_s`, default 60); devuelve el mismo payload que `session_status`. Preferir esta tool al bucle de polling: el agente no gasta tokens mientras espera. Si expira devuelve `state: waiting` y se puede volver a llamar.
- `fairdrop_status`: consultar métricas públicas.

Para recibir: crear sesión, mostrar el código al usuario y consultar el estado
hasta que `received` contenga los archivos. Recibir archivos no ejecuta su contenido.

## Variables opcionales

- `FAIRDROP_URL`: signaling; por defecto `wss://fair-drop.dniskav.com/ws`.
- `FAIRDROP_STATUS_URL`: métricas; por defecto `https://fair-drop.dniskav.com/api/status`.

**Probado desde fuera del VPS (2026-10-07):** un agente ejecutando
`mcp/index.js` en su propia máquina (solo Mac + Node + `bun install` en `mcp/`)
creó una sesión con el signaling de producción, el usuario entró con el código
desde el navegador y recibió el archivo; la sesión se cerró sola al entregar.
