# PETSHROW ERP — Browser (Chrome) access: what is ready, what is not

Status: **prepared, not deployed.** No public URL exists. Nothing here was published, and no hosting account was used.

## What is already true (verified)

The desktop renderer is the same React app a browser can run. `frontend/src/lib/api.js` and `socket.js` fall back to a
relative `/api` base when `window.electron` is absent ("plain-browser mode"), and the backend can serve the built SPA itself
(`FRONTEND_DIST` in `backend/src/index.js`, with an SPA fallback).

Verified on 2026-10-14 with a loopback-only stub server (no real backend, no database): the built `frontend/dist` loads in a
plain browser tab with no Electron, calls `GET /api/auth/me`, receives 401 and renders the Arabic login screen
(username / password / دخول). **Not verified:** a real login, the data screens, printing, Excel export and live updates in a
browser against a real backend (Electron-only paths — `window.electron` is referenced in 11 files — degrade or are skipped).

## Architecture constraints that decide the hosting target

1. **ZKTeco devices live on the office LAN.** The backend pulls punches from them (TCP 4370). A backend hosted in a public
   cloud cannot reach `192.168.x.x` devices, so attendance sync would stop. The backend therefore has to stay on a machine
   inside the office network.
2. **MySQL must never be exposed.** Keep it bound to `127.0.0.1` / a private network. Browsers talk only to the Node API;
   the database URL exists only in the server's own environment.
3. The backend refuses to listen on a network interface unless `AUTH_ENABLED=true` and a real `JWT_SECRET` are set
   (`backend/src/config/securityConfig.js`, `middleware/auth.js`). Do not weaken this for internet exposure.
4. Socket.IO needs a long-lived connection; serverless platforms (Vercel, Netlify functions) cannot host this backend.

## Recommended target (needs your action)

Keep the backend on the office server and publish it through an HTTPS tunnel, so no inbound port is opened and MySQL stays
local:

1. Pick the machine that already runs the backend and can reach the devices.
2. Set its environment (names only — never commit values):
   `AUTH_ENABLED=true`, `JWT_SECRET=<long random, unique to this deployment>`, `JWT_EXPIRES`, `PORT`,
   `FRONTEND_DIST=<path to the built frontend/dist>`, `CORS_ORIGINS=https://<your-public-hostname>`,
   `DATABASE_URL=mysql://…@127.0.0.1:3306/…`. `HOST` unset = `0.0.0.0`; behind a tunnel prefer `HOST=127.0.0.1`.
3. Create the first admin account with `backend/scripts/create-admin-user.js` (see the header of that script for usage).
4. Create a tunnel/domain in **your** account (for example Cloudflare Tunnel → `http://127.0.0.1:<PORT>`), with an access
   policy in front of it if possible. This requires your account login, which was not available.
5. Verify from another network, in Chrome: `https://<hostname>/api/health` answers, `https://<hostname>/api/auth/me`
   answers **401** without a token, the login screen appears, and `<server-ip>:3306` is unreachable from outside.

A cloud VPS is possible only if the office devices are reachable from it (site-to-site VPN); otherwise device sync breaks.

## Not done and why

No hosting provider, domain or credentials were available (the Vercel CLI on this PC is not logged in), and the hosting
decision above is yours. No URL is claimed.
