# `@paperclipai/plugin-ollama`

Companion plugin for the `ollama_local` adapter. Surfaces a settings page,
dashboard widget, license-acknowledge flow, health probe, and cost-ledger math
for agents running against a local [Ollama](https://ollama.com) instance.

- Plugin id: `paperclipai.plugin-ollama`
- Pairs with: [`@paperclipai/adapter-ollama-local`](../../adapters/ollama-local)
- Capabilities: `instance.settings.register`, `plugin.state.{read,write}`, `jobs.schedule`, `http.outbound`, `secrets.read-ref`, `events.subscribe`, `ui.page.register`, `ui.dashboardWidget.register`

---

## What it does

- **Settings page (`ollama-settings`)** — Test Connection button, list of pulled
  models with license badges, Acknowledge / Revoke per model family, unknown-license
  banner. Required before an agent can be trusted to run that family.
- **Dashboard widget (`ollama-health-widget`)** — health dot, model count,
  latest probe latency, last error, a Refresh button, and the running
  equivalent-hosted-cost figure with token totals.
- **Scheduled job (`ollama-health`, `*/5 * * * *`)** — polls `GET /api/tags`
  every 5 minutes, caches `HealthState` under `plugin.state` key
  `ollama-health`.
- **Cost ledger** — subscribes to `cost_event.created` events filtered on
  `provider === "ollama"`, accumulates token totals into
  `ollama-usage-summary`, and multiplies by the configured reference-model
  rate to produce a dollar-equivalent figure for the widget.
- **License gate** — model families must be acknowledged before the UI marks
  them as safe to serve. The acknowledgement list is stored under
  `ollama-acknowledged-licenses`.

---

## Install

### Local source checkout

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/packages/plugins/plugin-ollama","isLocalPath":true}'
```

Or via the CLI:

```bash
paperclipai plugin install /absolute/path/to/packages/plugins/plugin-ollama --local
```

The plugin reaches `ready` once the worker is registered. Confirm from
`GET /api/plugins` that the `paperclipai.plugin-ollama` id is present and
`status === "ready"`.

### Updating the build

```bash
pnpm --filter @paperclipai/plugin-ollama build        # esbuild (default)
pnpm --filter @paperclipai/plugin-ollama build:rollup # rollup alternative
pnpm --filter @paperclipai/plugin-ollama test         # vitest
pnpm --filter @paperclipai/plugin-ollama typecheck
pnpm --filter @paperclipai/plugin-ollama dev          # watch mode
pnpm --filter @paperclipai/plugin-ollama dev:ui       # hot-reload UI on :4177
```

---

## Configuration

Instance config lives under `instanceConfigSchema` and is editable from the
settings page.

| Field | Default | Notes |
|---|---|---|
| `baseUrl` **(required)** | `http://127.0.0.1:11434` | Ollama HTTP endpoint. Must be a valid http(s) URL — validated in `onValidateConfig`. |
| `referenceHostedModel` | `gpt-4o-mini` | Hosted model used as the public-price baseline for equivalent-cost math. Change ONLY if you want the dashboard to compare against a different hosted SKU. |
| `referenceInputCostPerMTok` | `0.15` | USD per 1M input tokens charged by the reference model. |
| `referenceOutputCostPerMTok` | `0.60` | USD per 1M output tokens charged by the reference model. |
| `acknowledgedLicenses` | `[]` | Seeded acknowledgement list. Prefer using the Acknowledge button in the UI — this field is the persistence fallback. |

### Reference-model assumption (important)

The dashboard widget's "equivalent hosted cost" is **not** what running Ollama
costs (that's hardware amortisation + electricity — out of scope). It is
"what would you have paid if the same heartbeats had hit the hosted
`referenceHostedModel` instead". The default `gpt-4o-mini` at
`$0.15 / $0.60` per 1M tokens reflects OpenAI's published pricing as of
2026-04-20. Change the rates if that reference no longer matches the
baseline you want to compare against. The figure is informational; no actual
billing is derived from it.

---

## Data + actions (plugin API surface)

Consumed by the bundled UI; also callable from other plugins via
`ctx.dataOf(...)` / `ctx.actionsOf(...)` when capability-granted.

### Data

| Key | Shape | Notes |
|---|---|---|
| `health` | `HealthState` | Cached result of the last `/api/tags` probe. Falls back to a live probe if cache is empty. |
| `models` | `Array<{name, size, family, license, licenseKnown, acknowledged, blocked}>` | Live probe. `blocked = true` when license is unknown OR family not acknowledged. |
| `acknowledged-licenses` | `string[]` | Acknowledged model families. |
| `license-matrix` | `Array<{family, commercialUse, attributionRequired, ...}>` | Static matrix shipped in `src/licenses.ts`. |
| `usage-summary` | `{events, inputTokens, outputTokens, cachedInputTokens, lastEventAt, referenceModel, inputRatePerMTokUsd, outputRatePerMTokUsd, equivalentCostUsd}` | Cost-ledger snapshot. |

### Actions

| Name | Params | Returns |
|---|---|---|
| `test-connection` | — | `{ok, status, latencyMs, modelCount, baseUrl, error}` |
| `refresh-health` | — | `HealthState` (forces a fresh probe + cache write) |
| `acknowledge-license` | `{family: string}` | `{ok, family, acknowledged}` — rejects unknown families |
| `revoke-license` | `{family: string}` | `{ok, family, acknowledged}` |
| `check-model` | `{model: string}` | `{model, family, license, licenseKnown, acknowledged, blocked, reason}` |
| `reset-usage` | — | `{ok}` — zeroes the cost ledger |

---

## Known limitations

- **SSRF guard on `127.0.0.1` — gated by deployment mode.** The default SSRF
  policy blocks loopback from `ctx.http.fetch`. M3 adds a narrow opt-in in
  `server/src/services/plugin-host-services.ts` that allows `127.0.0.1` / `::1`
  only when the server boots with `deploymentMode === "local_trusted"` **and**
  `deploymentExposure === "private"`. RFC 1918, link-local, and ULA ranges
  stay blocked regardless — a plugin can reach its own host, never the LAN.
  Any other deployment profile (cloud, authenticated multi-user) still rejects
  loopback; point the plugin at a reverse proxy bound to a public interface
  with an auth token in that case. Cost-event ingestion is unaffected — it
  flows through the plugin event bus, not outbound HTTP.
- **License gating is advisory.** The adapter itself (`ollama_local`) does NOT
  currently consume the acknowledgement list — the plugin surfaces it, but a
  determined operator can still configure the adapter with an un-acknowledged
  family. Adapter-side enforcement is deferred post-M2 per [GEM-8](/GEM/issues/GEM-8).
- **Equivalent-cost is approximate.** The `cost_event.created` payload exposes
  `inputTokens` + `outputTokens` only. Nothing in the Ollama API returns
  actual hosted-model pricing. The figure drifts if the reference model's
  rates change upstream — update the `referenceInput/OutputCostPerMTok`
  fields when that happens.

---

## Related issues

- [GEM-7](/GEM/issues/GEM-7) — M1 adapter MVP
- [GEM-8](/GEM/issues/GEM-8) — M2 companion plugin (this package)
- [GEM-9](/GEM/issues/GEM-9) — M3 hardening + docs
- [GEM-19](/GEM/issues/GEM-19) — `cost_event.created` fanout (unblocked the widget)
- [GEM-44](/GEM/issues/GEM-44) — bundled landing commit
