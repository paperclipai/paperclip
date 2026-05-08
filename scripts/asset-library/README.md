# Marketing Asset Library (`asset-library`)

Self-hosted Next.js 14 app that renders the Paperclip `[review-and-ship]` queue as
a single canonical surface for marketing-asset review/approval. Runs locally on
the founder's Mac at <http://127.0.0.1:7700/>.

Tracking issue: [GLA-927](/GLA/issues/GLA-927). Marketing freeze gate: [GLA-964](/GLA/issues/GLA-964).

## Status (W1A)

- ✅ Next 14.2.18 + React 18.3.1 + Tailwind 3 (App Router, no `src/`).
- ✅ `/` returns 200 with placeholder copy.
- ✅ `/api/issues` proxy to `GET $PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues`,
  filtered server-side to titles starting with `[review-and-ship]`.
- ✅ `pm2` ecosystem + `launchd` plist for autostart on login.

## Run locally

```sh
# dev (no pm2, no autostart)
npm run dev   # http://localhost:7700

# prod (pm2 + autostart)
npm run build
pm2 start ecosystem.config.js
pm2 save
```

## Env

Authoritative secrets live in
`/Users/jlqueguiner/.paperclip-worktrees/instances/paperclip-openrunner/secrets/notifier.env`
and are loaded by `ecosystem.config.js`. The proxy needs:

```
PAPERCLIP_API_URL
PAPERCLIP_API_KEY
PAPERCLIP_COMPANY_ID
```

Non-secret defaults (also in `.env.local`):

```
PORT=7700
ASSET_LIBRARY_PORT=7700
ASSET_LIBRARY_URL=http://127.0.0.1:7700
```

## Autostart on login

Plist source: `launchd/io.gladia.asset-library.plist` — committed for re-deploy.
Install / reload:

```sh
cp launchd/io.gladia.asset-library.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.gladia.asset-library.plist
# to reload after edits:
launchctl bootout  gui/$(id -u) ~/Library/LaunchAgents/io.gladia.asset-library.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.gladia.asset-library.plist
```

The plist runs `pm2 resurrect` (falls back to `pm2 start ecosystem.config.js`).

## Node version

Pinned to `node@20` (`/opt/homebrew/opt/node@20/bin/node`) via `interpreter` in
`ecosystem.config.js`. Next 14 currently mis-prerenders error pages on system
node 25.

## Verify

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7700/         # 200
curl -s http://127.0.0.1:7700/api/issues | head -c 200                  # JSON array
```
