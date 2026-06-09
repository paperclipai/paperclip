# paperclip-plugin-alertmanager

Receives Alertmanager v2 webhook deliveries and turns firing alerts into
Paperclip issues with the right assignee, priority, and observability
drill-in links. Resolves issues when the alert clears.

Designed to ride the existing Slack DM-on-assign chain: the plugin populates
`assigneeUserId` on `ctx.issues.create`, the Slack plugin's existing
`issue.created` listener picks it up and DMs the assignee. No coupling
between Slack and AM in code.

See `docs/specs/2026-04-29-alertmanager-plugin-spec.md` for the full design.

## What it does

- Verifies the `Authorization: Bearer <token>` header on every webhook
  delivery (constant-time compare).
- Parses the AM v2 envelope, drops malformed / unsupported-version payloads
  with a 200 (so AM doesn't retry-storm).
- Deduplicates by `alert.fingerprint` per spec §5.3 — re-fires bump the
  state row and refresh the issue body, they don't create a second issue.
- Re-opens issues that a human closed (status=done) when the same
  fingerprint re-fires (§8.3 option A).
- Resolves issues per `autoCloseOnResolve`: either close the issue (status
  → done) or post an `Alert resolved at <ts>` comment.
- Renders observability drill-in links (Grafana / Tempo / Pyroscope / Hubble
  / runbooks / Prometheus) from a fixed annotation-key allowlist, so a bad
  `PrometheusRule` can't smuggle hostile URLs into the issue body.
- Emits `plugin.alertmanager.alert.firing` and
  `plugin.alertmanager.alert.resolved` so sibling plugins (status pages,
  paging integrations) can subscribe.

## Configuration

Configured per-instance via the host's plugin settings UI. Schema lives in
`src/manifest.ts` (`instanceConfigSchema`).

| Key                  | Type    | Required | Notes |
|----------------------|---------|----------|-------|
| `defaultCompanyId`   | string  | yes      | Company that receives alerts when no routing label is set. |
| `webhookTokenRef`    | secret-ref | recommended | Static bearer token. AM sends `Authorization: Bearer <token>`. |
| `webhookToken`       | string  | dev only | Inline token; use `webhookTokenRef` in production. |
| `acceptOnlyLabels`   | object  | no       | Accept-only label filter, e.g. `{ paperclip: "true" }`. |
| `severityToPriority` | object  | no       | Override the default severity map. |
| `autoCloseOnResolve` | boolean | no       | Defaults to false (comment-only). |
| `ownerMap`           | object  | no       | `{ <labelKey>: { <labelValue>: <email> } }`. |

### Example `AlertmanagerConfig` YAML

```yaml
# Alertmanager-side — points AM at this plugin's webhook endpoint.
receivers:
  - name: paperclip
    webhook_configs:
      - url: https://paperclip.example.com/api/plugins/<instance>/webhooks/alertmanager
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/paperclip-token
route:
  receiver: paperclip
  group_by: [alertname, severity]
  repeat_interval: 4h
```

### Example plugin-side instance config (UI form values)

```yaml
defaultCompanyId: 11111111-1111-1111-1111-111111111111
webhookTokenRef: paperclip-alertmanager-token  # secret UUID, not the raw value
acceptOnlyLabels:
  paperclip: "true"
severityToPriority:
  critical: critical
  warning:  high
  info:     medium
autoCloseOnResolve: false
ownerMap:
  class:
    paperclip_claude_k8s: support@blockcast.net
  team:
    platform:   alice@blockcast.net
    networking: ned@blockcast.net
```

The bundled Blockcast plugin ships `class.paperclip_claude_k8s -> support@blockcast.net`
as a default route so `ClaudeK8sConcurrentRunBlockedRate` alerts remain owned after
a fresh deploy or plugin reinstall. Instance config is merged on top, so operators
can override that route or add more routes in the settings UI without losing the
default.

### Owner resolution chain (§7.7)

First hit wins:

1. `alert.labels.paperclip_assignee_email`
2. `ownerMap[<label>][<value>]` matched against `alert.labels`
3. `alert.annotations.paperclip_assignee_email`
4. unassigned

Resolved emails are looked up against `ctx.users.findByEmail` and cached
per email in plugin state (`owner-by-email:<email>`). Negative results are
cached too (empty string) so a missing user doesn't cause repeated lookups.

### Severity → priority defaults

| Severity | Priority |
|----------|----------|
| critical | critical |
| warning  | high     |
| info     | medium   |
| (other)  | medium   |

### Observability drill-in links

The plugin renders these annotation keys (and the alert's `generatorURL`)
as a `### Drill in` markdown section in the issue body. Anything else
ending in `_url` is ignored.

| Annotation key   | Renders as |
|------------------|------------|
| `dashboard_url`  | Dashboard |
| `trace_url`      | Tempo trace |
| `profile_url`    | Pyroscope flamegraph |
| `logs_url`       | Loki / journal logs |
| `flow_query_url` | Hubble flow query |
| `runbook_url`    | Runbook |
| (alert.generatorURL) | Source query in Prometheus |

## Security

- **Always set `webhookTokenRef` in production.** Without a token the
  webhook endpoint rejects every request — there is no "open" mode.
- **IP allowlist at ingress** as defense in depth. Alertmanager pods reschedule on
  restart and their pod IP changes; allowlist the namespace's pod CIDR
  rather than per-pod IPs.
- **mTLS is the V2 upgrade path** for stronger mutual auth (spec §11 Q4).
  Static bearer is V1 because it's the lowest-friction way to get rolling.
- The bearer token is kept in worker memory only — never written to plugin
  state, never logged.

### Bearer rotation in a Kubernetes deployment

In a typical onprem-k8s deployment the bearer value lives in three places
that all have to move together. Skipping any one of them strands a stale
copy that either fails auth or drifts silently. Use this order to avoid a
gap where Alertmanager presents the new value but the plugin still verifies
the old one (or vice versa):

1. Generate the new bearer (`openssl rand -base64 32`).
2. Patch the K8s `Secret` Alertmanager mounts as `credentials_file`. In
   the Blockcast/onprem-k8s layout this is
   `monitoring/alertmanager-receivers` key `bearer-token`. AM picks up the
   change automatically on its next config reload (`POST /-/reload` if
   you want to force it).
3. Rotate the paperclip secret-store entry referenced by
   `webhookTokenRef`. Use the secrets REST API
   (`POST /api/companies/:companyId/secrets/:secretId/rotate`) or, if you
   have direct DB access and the `local_encrypted` master key, append a
   new `company_secret_versions` row and bump
   `company_secrets.latest_version`. Plugin worker re-resolves on next
   webhook delivery — no restart needed.
4. (Defense in depth) Patch the second K8s `Secret`
   `paperclip/paperclip-alertmanager-webhook-token` so the env-driven
   `autoConfigureAlertmanagerFromEnv` bootstrap helper can re-seed a
   fresh deploy. Holds the same value as step 2; keep them in lockstep.
5. Verify with a synthetic AM webhook delivery:
   ```sh
   kubectl -n paperclip exec paperclip-0 -- wget -qS -O- \
     --header="Authorization: Bearer $NEW_TOKEN" \
     --header="Content-Type: application/json" \
     --post-data='{"version":"4","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"BearerRotationProbe","severity":"info"},"annotations":{},"startsAt":"...","endsAt":"0001-01-01T00:00:00Z","fingerprint":"rotation-probe-1"}]}' \
     http://127.0.0.1:3100/api/plugins/paperclip-plugin-alertmanager/webhooks/alertmanager
   ```
   Expect `HTTP 200` with `{"status":"success"}`.

## Build and test

```sh
pnpm --filter paperclip-plugin-alertmanager typecheck
pnpm --filter paperclip-plugin-alertmanager test
pnpm --filter paperclip-plugin-alertmanager build
```
