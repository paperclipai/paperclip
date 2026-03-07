Use this exact checklist.

1. Start Paperclip in auth mode.
```bash
cd <paperclip-repo-root>
pnpm dev --tailscale-auth
```
Then verify:
```bash
curl -sS http://127.0.0.1:3100/api/health | jq
```

2. Start a clean/stock OpenClaw Docker.
```bash
OPENCLAW_RESET_STATE=1 OPENCLAW_BUILD=1 ./scripts/smoke/openclaw-docker-ui.sh
```
Open the printed `Dashboard URL` (includes `#token=...`) in your browser.

3. In Paperclip UI, go to `http://127.0.0.1:3100/CLA/company/settings`.

4. Use the agent snippet flow.
- Copy the snippet from company settings.
- Paste it into OpenClaw main chat as one message.
- If it stalls, send one follow-up: `How is onboarding going? Continue setup now.`

5. Approve the join request in Paperclip UI, then confirm the OpenClaw agent appears in CLA agents.

6. Gateway preflight (required before task tests).
- Confirm the created agent uses `openclaw_gateway` (not `openclaw`).
- Confirm gateway URL is `ws://...` or `wss://...`.
- Confirm gateway token is non-trivial (not empty / not 1-char placeholder).
- Confirm pairing mode is explicit:
  - recommended default: `adapterConfig.disableDeviceAuth` is false/absent and `adapterConfig.devicePrivateKeyPem` is present
  - fallback only: `adapterConfig.disableDeviceAuth=true` when pairing cannot be supported in that environment
- If you can run API checks with board auth:
```bash
AGENT_ID="<newly-created-agent-id>"
curl -sS -H "Cookie: $PAPERCLIP_COOKIE" "http://127.0.0.1:3100/api/agents/$AGENT_ID" | jq '{adapterType,adapterConfig:{url:.adapterConfig.url,tokenLen:(.adapterConfig.headers["x-openclaw-token"] // .adapterConfig.headers["x-openclaw-auth"] // "" | length),disableDeviceAuth:(.adapterConfig.disableDeviceAuth // false),hasDeviceKey:(.adapterConfig.devicePrivateKeyPem // "" | length > 0)}}'
```
- Expected: `adapterType=openclaw_gateway`, `tokenLen >= 16`, `hasDeviceKey=true`, and `disableDeviceAuth=false`.

Pairing handshake note:
- The first gateway run may return `pairing required` once for a new device key.
- Approve it in OpenClaw, then retry the task.
- For local docker smoke, you can approve from host:
```bash
docker exec openclaw-docker-openclaw-gateway-1 sh -lc 'openclaw devices approve --latest --json --url "ws://127.0.0.1:18789" --token "$(node -p \"require(process.env.HOME+\\\"/.openclaw/openclaw.json\\\").gateway.auth.token\")"'
```

7. Case A (manual issue test).
- Create an issue assigned to the OpenClaw agent.
- Put instructions: “post comment `OPENCLAW_CASE_A_OK_<timestamp>` and mark done.”
- Verify in UI: issue status becomes `done` and comment exists.

8. Case B (message tool test).
- Create another issue assigned to OpenClaw.
- Instructions: “send `OPENCLAW_CASE_B_OK_<timestamp>` to main webchat via message tool, then comment same marker on issue, then mark done.”
- Verify both:
  - marker comment on issue
  - marker text appears in OpenClaw main chat

9. Case C (new session memory/skills test).
- In OpenClaw, start `/new` session.
- Ask it to create a new CLA issue in Paperclip with unique title `OPENCLAW_CASE_C_CREATED_<timestamp>`.
- Verify in Paperclip UI that new issue exists.

10. Watch logs during test (optional but helpful):
```bash
docker compose -f /tmp/openclaw-docker/docker-compose.yml -f /tmp/openclaw-docker/.paperclip-openclaw.override.yml logs -f openclaw-gateway
```

11. Expected pass criteria.
- Preflight: `openclaw_gateway` + non-placeholder token (`tokenLen >= 16`).
- Pairing mode: stable `devicePrivateKeyPem` configured with device auth enabled (default path).
- Case A: `done` + marker comment.
- Case B: `done` + marker comment + main-chat message visible.
- Case C: original task done and new issue created from `/new` session.

If you want, I can also give you a single “observer mode” command that runs the stock smoke harness while you watch the same steps live in UI.
