# GitHub PR Ingress

Syncs GitHub `pull_request` webhooks into Paperclip issues.

## What It Does

- Receives GitHub webhooks at
  `/api/plugins/keegoid.plugin-github-pr-ingress/webhooks/github-pull-request`
- Verifies `X-Hub-Signature-256` with a Paperclip secret UUID
- Maps configured `owner/repo` names to Paperclip companies
- Creates or updates one issue per PR using origin
  `plugin:keegoid.plugin-github-pr-ingress:github-pr`
- Stores delivery and PR sync state for idempotency

This plugin only observes PRs. The post-D4 routine that runs
`claude-review` / `codex-review` is intentionally separate.

## Config

```json
{
  "githubWebhookSecretRef": "00000000-0000-4000-8000-000000000000",
  "repositories": [
    {
      "repository": "keegoidllc/agentic-strategy-designer",
      "companyId": "5bb0401e-c8c3-4f04-abc6-ff7ef510afcb",
      "priority": "high"
    }
  ]
}
```

Optional mapping fields:

- `projectId`
- `parentIssueId`
- `assigneeAgentId`
- `priority`

## Development

```bash
pnpm install
pnpm dev
pnpm dev:ui
pnpm test
```

## Install Into Paperclip

```bash
PLUGIN_PATH="$(git rev-parse --show-toplevel)/packages/plugins/examples/plugin-github-pr-ingress"
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d "{\"packageName\":\"${PLUGIN_PATH}\",\"isLocalPath\":true}"
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
