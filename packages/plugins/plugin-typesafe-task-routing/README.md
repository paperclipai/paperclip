# TypeSafe Task Routing Pilot

Observation-only Paperclip plugin for OCC routing policy `1.0.0`. It subscribes to asynchronous `issue.created`, re-reads the issue, applies hard eligibility rules, and records a plugin-owned recommendation entity. It never mutates issue assignment, status, agent models, or customer-facing data.

## Configuration and disable

The `enabled` instance setting defaults to `false`. Set it to `true` only for the approved pilot. Disable immediately by setting `enabled` back to `false` or disabling/uninstalling the plugin. No data migration or rollback is required; prior recommendation records remain audit evidence.

The worker requires a OneCLI-managed gateway transport and never receives the TypeSafe provider key. It supplies a non-secret SDK placeholder, accepts only `https://api.typesafe.ai` in its custom fetch, and fails closed unless its process starts with `ONECLI_GATEWAY=true`, an HTTPS proxy, Node environment-proxy support, and OneCLI CA trust. The gateway injects the real credential according to the worker identity's grant. The dependency is pinned to `@typesafe-ai/sdk@0.6.0`, and requests are pinned to immutable model `jev-1.13.0`.

Production requires a dedicated OneCLI identity for this plugin worker, with only the existing TypeSafe secret granted, and its `getContainerConfig({ agent: "occ-typesafe-routing-plugin" })` result applied when the worker process is spawned. Do not use the Paperclip server's identity and do not copy the provider key into plugin config.

## Data handling

Only issue title, description, project id/name, and the approved routing criteria are sent. Audit records include issue id, input revision, policy/question/model versions, raw/effective decision, approved agent mapping, probabilities/confidence, sufficiency probability, latency, and token usage. No credentials, comments, attachments, customer profiles, order records, or payment records are read or sent. Governed-action requests are excluded before evaluation.

## Verification

```sh
pnpm --filter @paperclipai/plugin-typesafe-task-routing test
pnpm --filter @paperclipai/plugin-typesafe-task-routing typecheck
pnpm --filter @paperclipai/plugin-typesafe-task-routing build
```
