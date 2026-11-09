# VISP annotation server

WebSocket + file server that serves a VISP project's EMU-DB over the EMU-webApp websocket
protocol, to both annotation tools: **Artic** (the EMU-webApp frontend) and **TRATT** (its
VISP workspace). Named `emu-webapp-server` before VISP 1.2.0.

There is no subdomain of its own. Apache proxies to `annotation-server:17890` from each
app's host, so every request is same-origin for the app that makes it:

| App | Websocket | Audio |
|:---|:---|:---|
| Artic | `wss://artic.<BASE_DOMAIN>/` | `https://artic.<BASE_DOMAIN>/file/…` |
| TRATT | `wss://tratt.<BASE_DOMAIN>/annotation-ws` | `https://tratt.<BASE_DOMAIN>/file/…` |

Audio URLs in `GETBUNDLE` are built on the origin the websocket came from (falling back to
`MEDIA_FILE_BASE_URL`). TRATT needs that: it runs under COEP `credentialless`, which strips
the session cookie from cross-origin requests.

## Run

- Image: `node:24.15.0-bookworm-slim`, default `CMD npm run dev` (nodemon with `--exitcrash`);
  the prod quadlet overrides the command to `npm start`.
- Build/run through the deployment repo: `./visp.py build annotation-server`.

## Required environment

The server **exits** (non-zero) if any of these is unset; systemd (`Restart=always`)
retries, so a wrong config shows up as a restart loop in the journal, not a silent failure:

| Variable | Meaning |
|:---|:---|
| `MONGO_URI` | MongoDB connection string |
| `MONGO_DB_NAME` | Application database |
| `REPOSITORIES_PATH` | Container path of the project repositories (`/repositories` in the deployment, bind-mounted from the host's `mounts/repositories`) |
| `MEDIA_FILE_BASE_URL` | Fallback base URL for audio; also the WebSocket origin allowlist when `ALLOWED_ORIGINS` is unset |

Optional: `WS_SERVER_PORT` (default `17890`), `ALLOWED_ORIGINS` (comma-separated origins;
foreign origins are rejected with 403 at upgrade), `LOG_LEVEL`. Note that `.env-example`
also lists `MONGO_ROOT_PASSWORD`, which this server never reads — the credential is in
`MONGO_URI`.

Mongo must provide three collections: `projects` (project metadata), `users` (with a
`phpSessionId` field), and `bundlelists`.

## Storage layout

EMU-DB files live in the project repositories on disk, addressed by **project id** (URL
encoded), not username:

```
<REPOSITORIES_PATH>/<projectId>/Data/VISP_emuDB/<session>_ses/<bundle>_bndl/
```

All path construction goes through `src/pathSecurity.js` (traversal-safe); only `.wav`
files are served.

## Endpoints

- `WS /` — the EMU-webApp protocol (`GETPROTOCOL`, `GETBUNDLE`, `SAVEBUNDLE`, …;
  auth-gated, origin-checked, re-authorized per message). Bundle media URLs are returned
  as `mediaFile` entries with `GETURL`-style encoding, on the connection's origin.
- `GET /file/project/:projectId/session/:sessionName/file/:fileName` — audio file download,
  same auth + `.wav`-only rule; this is the route Apache proxies.
- `SAVEBUNDLE` updates **existing** bundles only, and only declared SSFF extensions.
- `GETBUNDLE`, `SAVEBUNDLE` and `/file` serve only bundles in the user's own bundle list for
  the project (`bundlelists`, written by VISP's *Assign annotation tasks* dialog); project
  membership alone is not enough (`src/bundleAccess.js`).

## Authentication

The auth module is **hard-coded to `VispAuth`** (`src/authModules/visp.module.js`); there is
no pluggable-module selection. `VispAuth` validates the `PHPSESSID` against the MongoDB
`users.phpSessionId` field and checks project membership — it does not call the PHP backend.

Re-authentication happens **per WebSocket message and per `/file` request**, on purpose:
logging out or losing project membership takes effect immediately. There is no auth cache.
(`getUser` and the old `authCache` machinery are dead legacy code kept for reference.)
