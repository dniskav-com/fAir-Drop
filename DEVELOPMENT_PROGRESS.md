# Desarrollo — Progreso y notas

Fecha: 2026-04-12

## Resuelto

- Fix WebSocket proxy: las variables de entorno del script `dev` solo aplicaban a `node server.js` y no a `vite`. Corregido separando los prefijos: `PORT=3003 node server.js & SERVER_PORT=3003 VITE_PORT=3002 vite`.
- Dark mode estilo Apple con toggle sol/luna. Persiste en `localStorage` (`fairdrop-theme`). Por defecto oscuro.
- Coherencia de dark mode: eliminados todos los `background: white` y `rgb(255 255 255 / ...)` hardcodeados; reemplazados por tokens CSS (`--panel-solid`, `--panel-tint`, etc.).
- i18n sin dependencias externas: español, inglés, francés, alemán. Detecta idioma del navegador. Persiste en `localStorage` (`fairdrop-locale`). Selector con banderas en la UI (🇪🇸 ES / 🇬🇧 EN / 🇫🇷 FR / 🇩🇪 DE).
- CI/CD: pipeline de GitHub Actions en `.github/workflows/deploy.yml`. Push a `main` → SSH al VPS → `git pull` + `bun install` + `bun run build` + `pm2 reload fairdrop`. Usa los secrets de organización de GitHub (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`).

## Puertos actuales

- Dev: Vite UI en `:3002`, Express/WS en `:3003`
- Producción (VPS): Express sirve `dist/` en `:3002`
