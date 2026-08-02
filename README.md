# Monster Fusion Masters — Online Link

Online multiplayer prototype for the **Competitive Rule / Rule 20200629** board game.

## Features

- Temporary six-character alphanumeric nicknames
- Password-protected rooms, ready state, host transfer, kick, leave, surrender, and spectators
- Desktop game/spectator UI and a compact mobile controller UI
- Turn timer with automatic pass
- Cloudflare Durable Objects for real-time room state
- GitHub Pages for the public player page

## Project layout

- `outputs/competitive-rule.html` — original local game prototype
- `online/src/worker.js` — Cloudflare Worker and Durable Objects server
- `online/client` — online game client logic
- `online/public` — online lobby and styles
- `online/scripts/build.mjs` — static player-page build

## Local development

```text
cd online
pnpm install
pnpm dev
```

Open `http://127.0.0.1:8787/`.

## Deployment

- `.github/workflows/deploy-cloudflare.yml` deploys the multiplayer server.
- `.github/workflows/deploy-pages.yml` builds and publishes the player page.
- Set the repository variable `CLOUDFLARE_WORKER_URL` to the deployed Worker URL.
- The Cloudflare workflow also requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

Room and account data are intentionally temporary and are not a permanent account system.
