# Homelab Dashboard

A phone-friendly dashboard for one Proxmox server. It shows live status for the host, containers, VMs and the web apps running on them, and (after unlocking with the dashboard password) can create, power-cycle and delete guests, manage site routes, read logs and apply updates.

It runs on CT 105 ("FrontPage") and is installable as a phone app (PWA).

## Pages

| Page | What it does |
| --- | --- |
| Overview | Host CPU / memory / disk, every guest with power and log shortcuts, uptime and history graphs |
| Services | The apps in `services.json` grouped by owner, with live up / down checks |
| Topology | Map of containers, addresses and what runs in each |
| Sites | Reverse-proxy routes, WordPress and AI-built sites (unlock to edit) |
| Notes | Shared scratch note, prompts and to-dos |
| Logs | Proxmox tasks and container / app logs (unlock) |
| Updates | Check and install OS updates (unlock) |
| Agents | The agents hub on CT 111: agents, tasks, activity (unlock) |
| Create | Provision a new LXC / VM, WordPress site or AI-built site (unlock) |

Press `Ctrl+K` / `Cmd+K` for the command bar (jump to any page, site or container), and `/` to search the current page.

## Architecture

- **Frontend:** React 19 + TypeScript, built with Vite. Plain CSS in `src/styles/global.css` (no CSS framework, no web fonts, no canvas). Pages other than Overview are lazy-loaded.
- **Backend:** `server.js`, a single Express 5 app. It serves `dist/` and a JSON API, and talks to the Proxmox API with an API token, plus the proxy agent, site agent, host agent and agents hub over the LAN.
- **Config:** `src/config/services.json` lists sites, members, container stacks and addresses. The server and the UI both read it.
- **PWA:** `public/manifest.webmanifest`, `public/icon.svg` and `public/sw.js`. The service worker is network-first and never caches `/api/*`.

Public API routes other sites depend on: `/api/ping`, `/api/stats`, `/api/services`, `/api/history`, `/api/uptime`. Do not break them.

## Develop

```sh
npm ci
npm run build     # tsc -b && vite build -> dist/
npm start         # node server.js (reads .env), http://localhost:3000
npm run dev       # Vite dev server (no API)
npm run lint
```

## Configuration

Copy `.env.example` to `.env` and fill it in. Never commit `.env`. Variable names:

- Server: `PORT`
- Proxmox: `PROXMOX_URL`, `PROXMOX_NODE`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET`, `PROXMOX_READ_TOKEN_ID`, `PROXMOX_READ_TOKEN_SECRET`, `PROXMOX_INSECURE_TLS`
- Create / delete: `DASHBOARD_PASSWORD` (alias `PROVISION_PASSWORD`), `PROXMOX_LXC_OSTEMPLATE`, `PROXMOX_STORAGE`, `PROXMOX_BRIDGE`, `PROXMOX_VM_TEMPLATE`
- Sites page: `PROXY_AGENT_URL`, `PROXY_AGENT_TOKEN`, `SITE_AGENT_URL`, `SITE_AGENT_TOKEN`
- Logs / updates: `HOST_AGENT_URL`, `HOST_AGENT_TOKEN`
- Agents page: `HUB_URL`, `HUB_API_KEY`
- Notes: `NOTES_FILE`
- Game server results: `DASHBOARD_SERVICE_TOKEN` (shared secret for `POST /api/game/results`, at least 24 characters, entered by the owner on CT 105 and on the WILDCARD game server; unset = the endpoint answers 503)

### Server-reported game results (WILDCARD // 2077)

`POST /api/game/results` is called by the game server (CT 113), not by browsers. It needs `Authorization: Bearer <DASHBOARD_SERVICE_TOKEN>`
(compared in constant time) and a strictly validated JSON body (see `wildcard-server/README.md` in `arcade-2077`, "Results contract").
It is idempotent on `matchId` (and the `Idempotency-Key` header, which must equal it), pays XP and eddies only to `kind: "user"` entries whose
account exists, is active and was not afk, writes a `game.results` audit entry, and records the match in `game_results` (unique `matchId`).
The XP rules are in `game-results.js` (`computeAward`).

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`:

1. GitHub builds the site (`npm run build`) and uploads `dist/`, `server.js`, `services.json` and the package files.
2. The self-hosted `frontpage` runner on CT 105 syncs them into `/opt/landingPage` (keeping `.env`, `node_modules` and `data/`), runs `npm ci --omit=dev`, restarts the `landing-page` pm2 process and waits for `/api/ping`.

Other branches and pull requests only run the CI build check (`.github/workflows/ci.yml`).
