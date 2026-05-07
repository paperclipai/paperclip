# Linear MCP cutover (SUP-18)

Operator runbook for moving the Linear API key out of the world-readable
`/paperclip/.claude.json` plaintext file into the encrypted secret store, and
configuring the CEO + Lead Engineer agents to load `mcp-linear` per heartbeat
through the new `adapterConfig.mcpServers` propagation.

## Prereqs

- Tasks 1–5 of the SUP-18 plan merged to `master` and deployed to
  `paperclip.nveron.com`.
- A board JWT for the company `084af715-a80f-4916-b8b7-cdd34bf4fc67`
  (the-bradery). Below this is `$TOKEN`.
- The current plaintext key from `/paperclip/.claude.json` (the
  `lin_api_…` value under `projects./.mcpServers.linear.env.LINEAR_API_KEY`).
  This is referenced as `$LINEAR_API_KEY_VALUE` below — never paste it into a
  comment or commit.

## 1. Create the company secret

```bash
TOKEN="<board-jwt>"
COMPANY=084af715-a80f-4916-b8b7-cdd34bf4fc67
LINEAR_API_KEY_VALUE="$(jq -r '.projects."/".mcpServers.linear.env.LINEAR_API_KEY' /paperclip/.claude.json)"

curl -sS -X POST "https://paperclip.nveron.com/api/companies/$COMPANY/secrets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg v "$LINEAR_API_KEY_VALUE" '{
    name: "linear-api-key",
    provider: "local_encrypted",
    value: $v,
    description: "Personal Linear API key (the-bradery workspace). Migrated from /paperclip/.claude.json. Rotate to a read-only scope as a follow-up."
  }')"
```

Capture the returned `id` field as `$SECRET_ID`. The response also returns
`latestVersion: 1`.

## 2. Patch CEO and Lead Engineer agent configs

```bash
SECRET_ID="<id from step 1>"
CEO=33d22c9f-7f7f-4b09-aa38-58d35c6ab62c
LEAD=65af5a28-4fd9-47ad-b86a-fdca17987732

PATCH_BODY=$(jq -n --arg sid "$SECRET_ID" '{
  adapterConfig: {
    mcpServers: {
      linear: {
        type: "stdio",
        command: "mcp-linear",
        args: [],
        env: {
          LINEAR_API_KEY: { type: "secret_ref", secretId: $sid, version: "latest" }
        }
      }
    }
  },
  replaceAdapterConfig: false
}')

curl -sS -X PATCH "https://paperclip.nveron.com/api/agents/$CEO" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$PATCH_BODY"
curl -sS -X PATCH "https://paperclip.nveron.com/api/agents/$LEAD" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$PATCH_BODY"
```

`replaceAdapterConfig: false` merges into the existing config rather than
overwriting it. Confirm in each response that the rest of `adapterConfig`
(`model`, `env`, `cwd`, etc.) survived intact.

## 3. Remove the plaintext key

```bash
# Backup first.
cp /paperclip/.claude.json /paperclip/.claude.json.bak-pre-sup18
chmod 600 /paperclip/.claude.json.bak-pre-sup18

# Delete the linear stanza without rewriting the rest of the file.
node -e '
  const fs = require("fs");
  const path = "/paperclip/.claude.json";
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  if (data.projects && data.projects["/"] && data.projects["/"].mcpServers) {
    delete data.projects["/"].mcpServers.linear;
  }
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
'
chmod 600 /paperclip/.claude.json
grep -F lin_api_ /paperclip/.claude.json && echo "STILL PRESENT — abort" || echo "ok, plaintext gone"
```

If the `grep` line prints anything, restore from `.bak-pre-sup18` and stop —
do not proceed to step 4 with the plaintext still on disk.

## 4. Smoke from the CEO heartbeat

Post a comment on SUP-18 along the lines of "Smoke check: confirm Linear MCP
propagates and ENG-2696 is readable." This wakes the CEO. The CEO heartbeat
should:

- See `mcp__linear__*` tools in `ToolSearch`.
- Call the Linear MCP `getIssue` (or equivalent) tool on `ENG-2696` and reply
  on the issue with the title.

If `mcp__linear__*` is not present, the cutover failed. Restore step 3 from
the backup and diagnose before retrying.

## 5. After the smoke passes

- Move SUP-19 to `in_review` with a comment that links the smoke evidence.
- Comment on SUP-18 with the smoke transcript and a link to a follow-up issue
  for rotating the key to a read-only scope and switching to the HTTPS MCP at
  `mcp.linear.app/mcp`. The CEO closes SUP-18.

## Rollback

If anything goes wrong after step 3:

```bash
cp /paperclip/.claude.json.bak-pre-sup18 /paperclip/.claude.json
chmod 600 /paperclip/.claude.json
```

Then `PATCH /api/agents/$CEO` and `/api/agents/$LEAD` again with
`adapterConfig.mcpServers: {}` to remove the stanza, and optionally delete the
secret with
`curl -X DELETE "https://paperclip.nveron.com/api/companies/$COMPANY/secrets/$SECRET_ID" -H "Authorization: Bearer $TOKEN"`.
