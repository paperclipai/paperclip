# Superpowers: bulk skill sync and assignment

The **paperclip-plugin-superpowers** UI focuses on per-agent assignment in the Skill Marketplace. There is **no** “assign every obra/superpowers skill to every agent” control in the board UI today.

Use the maintenance script when you want:

1. A full **sync** of skill bodies from GitHub into `plugin_state` (same shape the plugin’s `syncFromGitHub` action would write).
2. **Every** synced skill ID written to **every** active agent’s `skill-assignments` row (`status` not `terminated` or `pending_approval`).

## Script

[`scripts/superpowers-bulk-assign-all.mjs`](../../scripts/superpowers-bulk-assign-all.mjs)

## Production run

Resolve the Superpowers plugin row id:

```bash
docker exec paperclip-db-1 psql -U paperclip paperclip -t -A \
  -c "SELECT id FROM plugins WHERE plugin_key = 'superpowers';"
```

Copy the script into the server container and run it **from `/app/server`** (so `@paperclipai/db` resolves), with `DATABASE_URL` already set in the container:

```bash
docker cp scripts/superpowers-bulk-assign-all.mjs paperclip-server-1:/tmp/superpowers-bulk-assign-all.mjs
docker exec -u node -w /app/server \
  -e PAPERCLIP_SUPERPLUGIN_ID='<uuid-from-query-above>' \
  paperclip-server-1 \
  node --import ./node_modules/tsx/dist/loader.mjs /tmp/superpowers-bulk-assign-all.mjs
```

Optional environment variables:

| Variable | Purpose |
|----------|---------|
| `PAPERCLIP_COMPANY_ID` | Only assign agents in this company (default: all companies). |
| `SUPER_GITHUB_REPO` | Default `obra/superpowers`. |

Remove `/tmp/superpowers-bulk-assign-all.mjs` from the container when finished if you do not want a stray copy on disk.

## After new agents or new upstream skills

- **New agent:** Re-run the script (idempotent) or assign manually in the marketplace.
- **New skills upstream:** Re-run the script to refresh `skill:*` rows and expand everyone’s `skillIds` list.
