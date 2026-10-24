# CheckIn for Intel Macs - build notes

## Which build runs where (documented minimums)

| Build | Electron | Minimum macOS | Command / workflow |
|---|---|---|---|
| **CheckIn Mac 1.1.5 (Intel, current)** | 32.3.3 | **10.15 Catalina** | `npm run electron:build:manager:mac:intel` (in `frontend/`) or the on-demand workflow *Build macOS Intel Client* |
| Manager client (both arches) | 30.5.1 | 10.15 | `npm run electron:build:manager:mac` |
| Legacy client (kept, not the default) | 26.6.10 | 10.13 | `npm run electron:build:mac:legacy` |
| Standalone (bundles MySQL) | 30.5.1 | 14.0 | `npm run electron:build:standalone:mac` |

Why 10.15: Electron 27 dropped macOS 10.13 / 10.14 (Chromium 117+), so the modern app cannot run on High Sierra or Mojave. Electron 33 needs
macOS 11, 38 needs macOS 12 and 44 needs macOS 13 (https://www.electronjs.org/docs/latest/breaking-changes). Electron 32 is therefore the newest
line that still starts on Catalina. The Prisma query engine bundled with the Server/Standalone editions is also built for macOS 10.15+
(Mach-O `minos` 10.15.0, measured on Prisma 5.22). The Manager client has no native modules of its own.

Electron 32 is outside Electron's own support window (only the latest three majors are supported); that is the price of supporting Catalina.

## Name, identity and user data of "CheckIn Mac"

* Product name / bundle: **CheckIn Mac** (`CheckIn Mac.app`); files `CheckIn-Mac-<version>-x64.dmg|zip`; version **1.1.5** (same as the server:
  `frontend/package.json`, `backend/package.json`, both lockfiles and `frontend/src/lib/branding.js`; `frontend/tests/connection/mac-identity.test.mjs` fails if they diverge).
* **Unchanged on purpose:** `appId com.petshrow.erp.manager` and the packaged name `petshrow-erp-manager`. They decide the bundle identifier (Keychain /
  permissions), the user-data folder `~/Library/Application Support/petshrow-erp-manager` (connection settings, update preferences, saved session, logs), the
  update-cache name, and the Manager edition detection in `frontend/electron/edition.js` (which compares the packaged name). Keeping them means settings left
  by the previous Mac app, which was removed from the Macs, are picked up again and nothing has to be migrated. Consequence: this app is the *same* app
  identity as the old Manager - it must not be installed next to it expecting separate data. If side-by-side isolation is ever needed, change `appId` and `name`
  together with `edition.js` (otherwise the app would start as the Server edition and try to run a backend that is not bundled).
* Updates: `publish` still points to `https://updates.petshrow.local/erp-manager/`, which is not reachable from the LAN today, so there is no automatic update;
  distribute the DMG by hand. The updater never installs a lower version than the one installed (`allowDowngrade = false`).

## Default server address

A Manager client with no saved connection starts pointed at `DEFAULT_SERVER_URL` (`frontend/electron/constants.js`, currently
`http://192.168.1.145:8080`). It is only a starting value: change it in *Connection Settings* or with *change server* on the connecting screen;
whatever is saved always wins. Plain HTTP means nothing on the wire is encrypted - use it on a trusted LAN only.

## Not covered / not verified

* The packaged app has not been run on a real Mac from this repo state; CI only inspects the bundle (arch, `LSMinimumSystemVersion`, Electron version).
* Builds are unsigned and not notarized: expect the Gatekeeper "Open anyway" step on first launch.
* Macs that cannot run macOS 10.15 (for example an iMac from mid-2011, last official macOS: High Sierra) cannot run this build; use the web client
  (the page served by the server) in a browser that still supports that OS, or the Legacy build.
