# Emergency Run JWT Revocation

Paperclip local adapter runs authenticate with short-lived run-scoped JWTs. If a run token is exposed, operators can deny that specific `run_id` without rotating the shared signing secret.

## Deny Run IDs

Set `PAPERCLIP_AGENT_JWT_DENIED_RUN_IDS` to the run IDs to deny. The value may be comma-separated, whitespace-separated, newline-separated, or a JSON array.

```bash
PAPERCLIP_AGENT_JWT_DENIED_RUN_IDS="576c63c1-6ddc-4daf-93b6-de30c3d34f32,c79d03a8-6929-499b-80fb-7b45ca48db5c,b42a052b-3ddc-4f2b-ba61-03bbe37f53f4"
```

After changing the setting, restart or redeploy the Paperclip server process. The denied run IDs are checked during local agent JWT verification before the request is accepted as an agent actor. Do not add bearer tokens, JWT signatures, API keys, or raw log excerpts to the setting.

## Remove Run IDs

Remove the run ID from `PAPERCLIP_AGENT_JWT_DENIED_RUN_IDS`, then restart or redeploy the Paperclip server process. Other valid agent JWTs continue to authenticate as long as their `run_id` is not listed and the token is otherwise valid.
