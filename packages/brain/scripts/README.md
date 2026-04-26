# Brain operator scripts

## seed-acl.ts

Seeds two ACL rows so the MCP server immediately has something to grant:

- `CEO` → `[AI, Dokumente]` — the Paperclip CEO agent's MVP scope
- `walter` → seven owner folders — Claude Code / Claude Desktop / n8n on Walter's own UUID

Run:

```bash
BRAIN_DATABASE_URL="postgres://walterschoenenbroecher.de@localhost:5432/paperclip_brain" \
  pnpm --filter @paperclipai/brain exec tsx scripts/seed-acl.ts
```

The script is idempotent (uses `setAcl` upsert), so it is safe to run repeatedly. Adjust the
`SEEDS` constant in the file to add more agents or change folder allowlists.

To inspect the result:

```bash
psql -h localhost -p 5432 -d paperclip_brain \
  -c "SELECT agent_id, allowed_folders, description FROM brain.agent_acl ORDER BY agent_id;"
```
