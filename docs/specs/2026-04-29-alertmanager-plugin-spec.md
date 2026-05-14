# paperclip-plugin-alertmanager

Date: 2026-04-29
Status: Draft / scope spec — not yet implemented
Owner: TBD

## 1. Background & motivation

On 2026-04-29 we hit a registry image-pull outage on the on-prem k8s cluster.
Root cause turned out to be a `CiliumNetworkPolicy` silently denying egress from
a worker node. The smoking gun was visible in Prometheus the whole time:

```
cilium_drop_bytes_total{direction="EGRESS", reason="Policy denied"}
  on node pve-3 had accumulated ~261 GB over a 21h window.
```

That metric was being scraped. Nobody was paged. Nobody noticed until the
registry started failing pulls and a human went looking. The chain that should
have caught this is:

```
Cilium agent  ──►  Prometheus (prometheus-0 / monitoring ns)  ──►  ???  ──►  human
```

The `???` is broken at every link:

- No `ServiceMonitor` for the Cilium agent — drop metrics are scraped only
  because of the default kube-state pipeline, not a maintained rule set.
- No `PrometheusRule` defining "policy-denied egress is sustained and large".
- **No Alertmanager is deployed in the cluster at all.** The Prometheus pod
  has nowhere to fan firing alerts out to.
- Even if Alertmanager existed, there is no integration that turns a firing
  alert into an actionable artifact (an issue, a page, a DM) for the right
  human.

This spec covers the last link only — turning Alertmanager webhooks into
Paperclip issues, with the right assignee, that ride the existing Slack DM
plumbing to wake somebody up. The other links (deploying Alertmanager,
authoring `ServiceMonitor` and `PrometheusRule` resources) are listed as
**blocking dependencies** in §8 but are out of scope for this plugin.

The 261 GB drop is one example. The same pipeline should generalize to:

- Pod OOMKilled events
- Certificate expiry < 14d
- BGP session flaps on a TR/edge node
- Deploy / rollout failures (`kube_deployment_status_replicas_unavailable`)
- Blackbox probes (synthetic HTTP / DNS / TCP)
- Disk pressure / inode exhaustion on hosts
- Backup job failures

A plugin that handles the generic Alertmanager v2 webhook contract handles all
of these without per-alert plumbing on the Paperclip side. Alert authors only
need to write a `PrometheusRule` and pick the right labels.

## 2. What this plugin reuses (already shipped — do NOT respec)

This work piggybacks on plumbing landed earlier in the same session:

1. **Users SDK client.** `ctx.users.get(id)` and `ctx.users.findByEmail(email)`
   are gated on the `users.read` capability and hit the server-side
   `auth_users` table. See sketch in
   `packages/plugins/paperclip-plugin-linear/src/worker.ts:117–140`
   (`resolvePaperclipUserIdForEmail`) for the lazy-cache pattern.
2. **Linear assignee mapping.** When the Linear plugin imports an issue, it
   resolves the Linear assignee's email to a Paperclip user id and passes
   `assigneeUserId` to `ctx.issues.create` (see
   `packages/plugins/paperclip-plugin-linear/src/worker.ts:596–606`). The
   server stores it on the issue row.
3. **Server emits `issue.created` and `issue.updated` events** with
   `assigneeUserId` (and `_previous.assigneeUserId` on updates) in the activity
   log details / event payload. The schema is consumed in
   `packages/plugins/paperclip-plugin-slack/src/worker.ts:1507–1525`.
4. **Slack DM-on-assign.** Slack plugin subscribes to those events; when
   `assigneeUserId` resolves through `resolveSlackUserId` (cached per Paperclip
   user) it DMs the assignee with a "You've been assigned…" message. See
   `packages/plugins/paperclip-plugin-slack/src/user-mapping.ts:17–50` and
   `packages/plugins/paperclip-plugin-slack/src/worker.ts:1469–1525`.

This plugin therefore does not need to know about Slack at all. It only needs
to populate `assigneeUserId` correctly on `ctx.issues.create` and the rest of
the chain fires for free.

## 3. Architecture

```
┌────────────────────────┐
│  Cilium agent (DS)     │
│  exposes /metrics      │
└──────────┬─────────────┘
           │ scrape
           ▼
┌────────────────────────┐         ┌───────────────────────────┐
│  Prometheus            │  rules  │  PrometheusRule           │
│  prometheus-0          │◄────────│  CiliumPolicyDropsHigh    │
│  monitoring ns         │         │  PodOOMKilled             │
└──────────┬─────────────┘         │  CertExpiringSoon         │
           │ alerts                │  ...                      │
           ▼                       └───────────────────────────┘
┌────────────────────────┐
│  Alertmanager          │   ◄── NOT DEPLOYED YET — blocking dep §8
│  alertmanager-main     │
└──────────┬─────────────┘
           │ webhook (HTTP POST, AM v2 schema)
           ▼
┌────────────────────────────────────────────────┐
│  Paperclip server                              │
│   /webhooks/<instance>/<endpointKey>           │
│           │                                    │
│           ▼                                    │
│  paperclip-plugin-alertmanager  (this plugin)  │
│   - parse + validate AM v2 payload             │
│   - per-alert: dedup by fingerprint            │
│   - resolve assignee (owner-map → users.findByEmail)
│   - ctx.issues.create({ assigneeUserId, ... }) │
│   - ctx.events.emit("plugin.alertmanager.alert.firing")
└──────────┬─────────────────────────────────────┘
           │ issue.created (server-emitted)
           ▼
┌────────────────────────────────────────────────┐
│  paperclip-plugin-slack                        │
│   - reads assigneeUserId from event payload    │
│   - resolveSlackUserId → Slack user            │
│   - DM "You've been assigned: <alert title>"   │
└────────────────────────────────────────────────┘
```

The on-call human gets a Slack DM with a link to a Paperclip issue that has
the alert's labels, annotations, runbook URL, severity, and a back-link to
Prometheus / source dashboard.

## 4. Manifest

Mirrors the shape used by the Slack plugin
(`packages/plugins/paperclip-plugin-slack/src/manifest.ts:10–229`).

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-alertmanager",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Alertmanager Webhook Receiver",
  description:
    "Receives Alertmanager v2 webhooks and converts firing alerts into Paperclip issues with the correct assignee, priority, and metadata. Resolves issues when alerts clear.",
  author: "blockcast-platform",
  categories: ["connector", "observability", "automation"],
  capabilities: [
    "issues.create",
    "issues.update",
    "issues.read",
    "users.read",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "webhooks.receive",
    "instance.settings.register",
    "activity.log.write",
    "metrics.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      defaultCompanyId: {
        type: "string",
        title: "Default company id",
        description:
          "Company that receives alerts when no company-routing label is present.",
      },
      webhookSecretRef: {
        type: "string",
        format: "secret-ref",
        title: "Webhook shared-secret (optional)",
        description:
          "If set, incoming webhooks must include header X-Paperclip-Auth: <secret>. Alertmanager supports static Authorization headers via http_config.",
      },
      acceptOnlyLabels: {
        type: "object",
        title: "Accept-only label filter",
        description:
          "If set, only alerts whose labels match all of these key=value pairs are accepted. Use to scope a shared-tenancy AM cluster.",
        additionalProperties: { type: "string" },
      },
      severityToPriority: {
        type: "object",
        title: "severity → priority map",
        default: { critical: "critical", warning: "high", info: "medium" },
        additionalProperties: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
      },
      autoCloseOnResolve: {
        type: "boolean",
        title: "Auto-close issue when alert resolves",
        default: false,
        description:
          "If true, transitions the issue to status=done when AM sends status=resolved. If false, posts a 'resolved at <ts>' comment and leaves status alone.",
      },
      ownerMap: {
        type: "object",
        title: "Owner map (label-key → owner-spec)",
        description:
          "Per-instance config. e.g. { team: { 'platform': 'alice@blockcast.net' } }. See §6 for resolution algorithm.",
      },
    },
    required: ["defaultCompanyId"],
  },
  webhooks: [
    {
      endpointKey: "alertmanager",
      displayName: "Alertmanager v2 webhook",
      description:
        "Alertmanager `webhook_configs` target. Accepts POST with the AM v2 JSON payload.",
    },
  ],
  // No tools registered for V1 — pure event/webhook plugin.
  tools: [],
};

export default manifest;
```

### 4.1 Events emitted

The plugin emits two domain events via `ctx.events.emit`. Naming follows the
convention used by Slack (`plugin.slack.thread_message`,
`plugin.slack.agent-stream-chunk` — see worker.ts:1255–1346):

- `plugin.alertmanager.alert.firing` — payload includes `fingerprint`,
  `alertname`, `severity`, `labels`, `annotations`, `paperclipIssueId`,
  `assigneeUserId`.
- `plugin.alertmanager.alert.resolved` — payload includes `fingerprint`,
  `alertname`, `paperclipIssueId`, `resolvedAt`.

These are subscribable from sibling plugins (e.g. a future Statuspage plugin
that posts to a public status page on critical fires).

## 5. Webhook contract

### 5.1 Source

Alertmanager `webhook_configs` (HTTP). Schema:
<https://prometheus.io/docs/alerting/latest/configuration/#webhook_config>
(payload schema:
<https://prometheus.io/docs/alerting/latest/notifications/>).

V2 payload top level:

```json
{
  "version": "4",
  "groupKey": "{}:{alertname=\"CiliumPolicyDropsHigh\"}",
  "truncatedAlerts": 0,
  "status": "firing",
  "receiver": "paperclip",
  "groupLabels": { "alertname": "CiliumPolicyDropsHigh" },
  "commonLabels": { "alertname": "...", "severity": "critical" },
  "commonAnnotations": { ... },
  "externalURL": "http://alertmanager.monitoring.svc:9093",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "CiliumPolicyDropsHigh",
        "severity": "critical",
        "team": "platform",
        "node": "pve-3",
        "direction": "EGRESS",
        "reason": "Policy denied"
      },
      "annotations": {
        "summary": "261 GB of EGRESS traffic dropped on pve-3 in 21h",
        "description": "...",
        "runbook_url": "https://wiki/runbooks/cilium-drops"
      },
      "startsAt": "2026-04-29T08:00:00Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "http://prometheus-0:9090/graph?...",
      "fingerprint": "9a3b1e4c5f6d7890"
    }
  ]
}
```

### 5.2 Handler responsibilities

In `onWebhook` (signature mirrors `paperclip-plugin-slack/src/worker.ts:1533`):

1. Verify auth. If `webhookSecretRef` is set, compare
   `input.headers["authorization"]` (case-insensitive) against
   `Bearer <secret>` with `timingSafeEqual` (mirroring the Slack signature
   check at worker.ts:87–111).
2. Validate `endpointKey === "alertmanager"`.
3. Parse `input.parsedBody` as the AM v2 envelope. Reject if `version` is not
   in `{"4"}` (the only schema currently published). Log + 200 on schema
   mismatch — Alertmanager retries on non-2xx and we don't want a poison
   payload to back up the queue.
4. For each `alert` in `alerts[]`:
   - Apply `acceptOnlyLabels` filter (if set, skip alerts that don't match).
   - Compute `effectiveStatus = alert.status ?? envelope.status`.
   - Branch: firing → `handleFiring(alert)`, resolved → `handleResolved(alert)`.

### 5.3 Idempotency

Alertmanager retries on connection errors, on non-2xx responses, and on its
own internal restart cycle. Combined with the fact that a single firing alert
will repeat-notify on the AM `repeat_interval` (default 4h), the plugin must
be idempotent on `(fingerprint, status)`.

The `alert:<fingerprint>` state row (see §5) is the dedup key. `handleFiring`
is upsert: if the row exists and points at an issue that is still open, it
just bumps `lastFiredAt` and re-emits the `plugin.alertmanager.alert.firing`
event (no DM re-sent — Slack DM dedup is handled by the Slack plugin's own
`assignee-dm-sent:<eventId>` state ref, worker.ts:1474–1481).

## 6. State model

All keys are scoped to `instance` (the plugin instance) unless noted.

```
alert:<fingerprint>           → {
  paperclipIssueId: string,
  paperclipCompanyId: string,
  assigneeUserId: string | null,
  alertname: string,
  severity: string,
  firstSeenAt: ISO8601,
  lastFiredAt: ISO8601,
  resolvedAt:  ISO8601 | null,
}

owner-by-email:<email>        → paperclip user id (cached)
                                ""  = negative cache (looked up, no match)

owner-map                     → mirror of config.ownerMap, editable from UI
                                without re-deploying the manifest.
```

## 7. Issue mapping

### 7.1 Title

```
[<severity>] <alertname>  ·  <commonLabels.team or node or "">
```

e.g. `[critical] CiliumPolicyDropsHigh · pve-3`

### 7.2 Description (markdown body)

```
**Summary**: <annotations.summary or alertname>

<annotations.description>

**Started**: <startsAt>
**Severity**: <severity>
**Source**: <generatorURL>
**Runbook**: <annotations.runbook_url or "—">

### Labels

| key | value |
|-----|-------|
| ... | ...   |
```

### 7.3 Priority

`config.severityToPriority[alert.labels.severity]`, falling back to `medium`.
Defaults: `critical → critical`, `warning → high`, `info → medium`.

### 7.4 Origin tags (so other plugins can correlate)

```
originKind: "plugin:paperclip-plugin-alertmanager"
originId:   alert.fingerprint
```

This lets `ctx.issues.list({ originKind, originId })` (see Linear pattern,
worker.ts:567–572) act as a server-side dedup belt-and-braces in case the
plugin state is wiped.

### 7.5 billingCode

If `alert.labels.billing_code` is set, pass it through. Lets a tenant-shared
cluster bill alerts to the right cost center.

### 7.6 Observability enrichment (drill-in links)

The cluster already runs the full observability stack — surface it on every
issue so the assignee lands on a flamegraph / trace / dashboard, not on a
title and a label table. Discovered during scope research:

| Signal      | Service                                  | Notes |
|-------------|------------------------------------------|-------|
| Metrics     | `prometheus-0` in `monitoring` ns        | Already scraped; alert source |
| Traces      | `tempo.monitoring.svc:4317` (OTLP gRPC)  | OTel collectors export here |
| Profiles    | `pyroscope.monitoring.svc:4040` + mTLS LB `69.25.95.140:443` | `alloy-ebpf` DaemonSet emits to it |
| Host metrics| `otel-collector` (4 replicas)            | hostmetrics + kubeletstats receivers |

Rather than hardwiring renderer logic per signal, **the plugin treats
known annotation keys as URLs and renders them as a "Drill in" section** at
the bottom of the issue body. This keeps the plumbing one-way (Prometheus
rule → AM annotation → plugin → issue) and lets each rule decide which
links are useful for that alert.

**Reserved annotation keys (rendered as a markdown link if present):**

| Key                   | Renders as            |
|-----------------------|-----------------------|
| `dashboard_url`       | "Dashboard" (Grafana panel for the firing series) |
| `trace_url`           | "Tempo trace" (deeplink into a representative trace) |
| `profile_url`         | "Pyroscope flamegraph" (filtered by `service=...` and the alert's time window) |
| `logs_url`            | "Loki / journal logs" (when Loki lands; key reserved now) |
| `flow_query_url`      | "Hubble flow query" (Cilium-specific; for network-policy alerts) |
| `runbook_url`         | "Runbook" (already used by AM convention; render here for consistency) |
| `generator_url`       | "Source query in Prometheus" (always set by AM; already shown above the table) |

**Rule-side template** (Prometheus rule author writes these once per rule;
the plugin doesn't need to know the URL shapes):

```yaml
- alert: CiliumPolicyDenyDropsHigh
  expr: rate(cilium_drop_bytes_total{reason="Policy denied"}[5m]) > 1e6
  annotations:
    summary: "Sustained policy-denied drops on {{ $labels.node }}"
    description: |
      Egress drops at >1 MB/s sustained on node {{ $labels.node }}.
      261 GB precedent on 2026-04-29; investigate which CNP and
      identity pair are being denied.
    dashboard_url: "https://grafana.example/d/cilium-drops?var-node={{ $labels.node }}&from={{ .StartsAt | toEpochMs }}&to=now"
    trace_url:     "https://grafana.example/explore?datasource=tempo&query=resource.k8s.node.name={{ $labels.node }}"
    profile_url:   "https://grafana.example/a/grafana-pyroscope-app/?serviceName=cilium-agent&from={{ .StartsAt | toEpochMs }}"
    flow_query_url: "https://hubble.example/?from={{ .StartsAt | toEpochMs }}&filter=verdict=DROPPED&node={{ $labels.node }}"
    runbook_url:   "https://runbooks.example/cilium-drops"
```

**Rendered "Drill in" block in the issue body:**

```markdown
### Drill in
- [Dashboard](https://grafana.example/d/cilium-drops?...)
- [Tempo trace](https://grafana.example/explore?datasource=tempo&...)
- [Pyroscope flamegraph](https://grafana.example/a/grafana-pyroscope-app/?...)
- [Hubble flow query](https://hubble.example/?...)
- [Runbook](https://runbooks.example/cilium-drops)
- [Source query in Prometheus](https://prometheus.example/graph?expr=...)
```

The plugin should preserve these on `issue.update` for `re-firing` events
(the timestamp range in the URLs may shift; replace the whole drill-in
block on each fire). On `resolved`, append a final "Resolved at <endsAt>"
comment but do NOT clear the links — they're still useful for the
post-mortem.

**Why a fixed key allowlist:** rendering arbitrary annotation keys as links
risks leaking sensitive labels or hostile URLs from a poorly-written rule.
Allowlist + logging of unrecognized observability-shaped keys (anything
ending in `_url` not in the table) gives ops a way to spot gaps without
invasive surfacing.

### 7.7 Owner / assignee resolution

In order, first hit wins:

1. **Direct override label.** `alert.labels.paperclip_assignee_email` →
   `ctx.users.findByEmail(email)`. Lets a `PrometheusRule` author force a
   recipient.
2. **Owner map by label key.** Iterate `config.ownerMap` (e.g.
   `{ team: { platform: "alice@blockcast.net" } }`), match against
   `alert.labels[key]`, resolve email → user.
3. **Annotation `paperclip_assignee_email`** (same lookup as 1, just named).
4. **Default per-company on-call** (future extension; out of scope V1).
5. **No assignee.** Issue is created unassigned — the issue still shows up in
   the company's queue, just nobody is paged.

The lookup goes through a cached helper (mirror of
`paperclip-plugin-linear/src/worker.ts:117–140`):

```ts
async function resolveOwnerUserId(
  ctx: PluginContext,
  email: string | undefined | null,
): Promise<string | undefined> {
  if (!email) return undefined;
  const normalized = email.trim().toLowerCase();
  const stateKey = `owner-by-email:${normalized}`;
  const cached = await ctx.state.get({ scopeKind: "instance", stateKey });
  if (typeof cached === "string" && cached.length > 0) return cached;
  if (cached === "") return undefined;
  try {
    const user = await ctx.users.findByEmail(normalized);
    const userId = user?.id ?? null;
    await ctx.state.set({ scopeKind: "instance", stateKey }, userId ?? "");
    return userId ?? undefined;
  } catch (err) {
    ctx.logger.warn(`Failed to resolve owner ${normalized}: ${err}`);
    return undefined;
  }
}
```

## 8. Lifecycle

### 8.1 firing

```
state = ctx.state.get("alert:<fp>")
if state && state.paperclipIssueId:
    # Re-fire — already have an issue. Just bump lastFiredAt + re-emit.
    state.lastFiredAt = now
    ctx.state.set("alert:<fp>", state)
    ctx.events.emit("plugin.alertmanager.alert.firing", {...})
    return

# First time we've seen this fingerprint.
assigneeUserId = resolveOwner(alert)
issue = ctx.issues.create({
    companyId: defaultCompanyId,
    title, description, priority,
    originKind: "plugin:paperclip-plugin-alertmanager",
    originId: alert.fingerprint,
    assigneeUserId,           # ← triggers Slack DM via existing chain
    billingCode,
})
ctx.state.set("alert:<fp>", { paperclipIssueId: issue.id, ... })
ctx.events.emit("plugin.alertmanager.alert.firing", {
    fingerprint, alertname, severity, labels, annotations,
    paperclipIssueId: issue.id, assigneeUserId,
})
ctx.metrics.write("alertmanager.firing.handled", 1, { severity, alertname })
```

### 8.2 resolved

```
state = ctx.state.get("alert:<fp>")
if !state:
    # Resolved before we ever saw firing — log and drop.
    ctx.logger.info(`resolved for unknown fingerprint ${fp}`)
    return

if config.autoCloseOnResolve:
    ctx.issues.update(state.paperclipIssueId,
                      { status: "done" },
                      state.paperclipCompanyId)
else:
    ctx.issues.createComment(state.paperclipIssueId,
        `Alert resolved at ${alert.endsAt}.`,
        state.paperclipCompanyId)

state.resolvedAt = alert.endsAt
ctx.state.set("alert:<fp>", state)
ctx.events.emit("plugin.alertmanager.alert.resolved", {
    fingerprint, alertname,
    paperclipIssueId: state.paperclipIssueId,
    resolvedAt: alert.endsAt,
})
```

> Note: `issues.createComment` requires the `issues.update` capability per
> `packages/plugins/sdk/src/protocol.ts:938–942`. Capability list above
> already includes it.

### 8.3 re-firing after manual resolve

If a human closed the Paperclip issue and the alert later re-fires, the
fingerprint is the same. We have two reasonable behaviours:

- **A**: re-open the existing issue (`status: "todo"`) and re-DM. Simple.
- **B**: create a new issue, link it to the prior one as `relatesTo`. More
  surface area, more honest about "this is a new incident".

Recommend **A** for V1 — fewer issues for the same root cause feels right for
flapping alerts. Surfaced as an open question (§11).

## 9. Deployment dependencies (out of scope, but blocking end-to-end)

This plugin alone fixes nothing. To deliver the 261-GB-drops-page-somebody
outcome, all of the following must also exist. Tracking them here so the
rollout plan in §10 is honest:

| Dep | Status | Owner |
|-----|--------|-------|
| Alertmanager StatefulSet in `monitoring` ns | **NOT deployed** | platform |
| Alertmanager `Receiver` config pointing at `https://paperclip/.../webhooks/<instance>/alertmanager` | depends on plugin URL | platform |
| `ServiceMonitor` for `cilium-agent` (port `prometheus`, path `/metrics`) | not deployed | networking |
| `PrometheusRule` for `CiliumPolicyDropsHigh`: `rate(cilium_drop_bytes_total{reason="Policy denied"}[15m]) > 1e7` for 10m, severity=critical | not authored | networking |
| `PrometheusRule` starter pack: `PodOOMKilled`, `CertExpiringSoon`, `NodeDiskPressure`, `BGPSessionDown`, `BlackboxProbeFailure` | not authored | platform |
| Network reachability from `monitoring` ns to Paperclip ingress | needs a `CiliumNetworkPolicy` allowing egress | networking (irony noted) |
| Paperclip user records exist for the on-call humans (alice@, bob@, ...) | partial | platform |

Pin these in a separate ops ticket. The plugin can be **built and unit-tested**
without any of them by replaying captured AM payloads against the local
plugin dev server.

## 10. Three-stage rollout plan

### Stage 1 — Local plugin tests (no AM, no cluster)

1. Build plugin in `packages/plugins/paperclip-plugin-alertmanager/`.
2. Capture a real Alertmanager v2 payload (one fire, one resolve) from the
   Prometheus docs or a synthetic generator.
3. Drive the plugin's local dev server (per
   `packages/plugins/sdk/src/dev-server.ts`) with `curl -X POST` against the
   webhook endpoint. Assert:
   - First firing creates an issue with the expected title/priority/labels.
   - Re-firing the same fingerprint does NOT create a second issue.
   - Resolved with `autoCloseOnResolve=false` posts a comment.
   - Resolved with `autoCloseOnResolve=true` flips status to done.
   - Owner-map resolution picks the right Paperclip user.
   - `acceptOnlyLabels` filter rejects mismatched alerts.
4. Wire up unit tests in `__tests__/` covering the matrix above.
5. Manual end-to-end against a dev Paperclip instance: trigger a curl-driven
   firing, confirm the Slack DM lands (this exercises the full Slack chain
   without involving Alertmanager).

### Stage 2 — Deploy Alertmanager + dummy alert

1. Deploy AM in `monitoring` ns (StatefulSet, 1 replica, ConfigMap-based
   config). Out of scope for *this* plugin's repo — separate k8s-side spec.
2. Configure AM with a single receiver pointing at the plugin's webhook URL.
3. Author one trivial `PrometheusRule`: `Watchdog` (always firing) or
   `vector(1) > 0.5` for 1m, severity=info.
4. Confirm Paperclip issue appears, assigned to the configured owner, and a
   Slack DM lands.
5. Resolve the alert (silence in AM or remove the rule). Confirm the
   resolution path runs.

### Stage 3 — Real alerts on real signals

1. Author the `ServiceMonitor` for `cilium-agent`.
2. Author `PrometheusRule.CiliumPolicyDropsHigh` (the would-have-caught-the-261-GB rule).
3. Author the starter pack from §8 (OOM, cert expiry, node pressure, BGP, blackbox).
4. Set `acceptOnlyLabels = { paperclip: "true" }` and tag every authored
   PrometheusRule alert with `paperclip: "true"`. Lets the `monitoring` ns be
   shared with future tenants without their alerts leaking into Paperclip.
5. Tune `repeat_interval` and dedup windows once we have a week of fire data.

## 11. Open questions

### Q1 — Cluster `monitoring` ns tenancy

Is the `monitoring` ns shared, or going to be shared, with workloads whose
alerts shouldn't flow into Paperclip? Two options:

- **Accept everything** — simpler, but any future co-tenant inherits this
  pipeline whether they want it or not.
- **Scope by label** — require `paperclip: "true"` (or a config-supplied
  selector) on every alert. Costs one extra label on every PrometheusRule
  but keeps blast radius bounded.

Recommendation: scope by label (`acceptOnlyLabels` in config). Authors who
want to opt out just don't add the label.

### Q2 — Resolved-alert behaviour

**Status: Resolved (V1).** Per-instance configurable via the manifest's
`autoCloseOnResolve: boolean` field (`src/manifest.ts`), default `false`
(= comment-only). Live cluster config takes the default. Re-open Q2 if a
`severityToCloseBehavior` extension is needed.

Discussion that led to the decision:

Auto-close the Paperclip issue, or just comment "resolved at X" and leave it
open?

- **Auto-close**: matches the way most humans work — alert stops, ticket
  goes away. But hides the fact that root cause was never investigated. Bad
  for chronic flappers.
- **Comment-only**: keeps the issue open until a human marks it done.
  Surfaces "is this actually fixed?" but creates noise on stable infra.

Recommendation taken: configurable per-instance, default to comment-only.
Critical-severity alerts probably want to stay open until somebody writes a
postmortem; info-severity alerts probably want auto-close. Consider a future
`severityToCloseBehavior` extension if the binary toggle proves coarse.

### Q3 — Owner-of-an-alert lookup source

**Status: Resolved (V1).** Plugin config map via the manifest's `ownerMap`
field, resolved by `src/owner-resolver.ts`. Resolution chain documented in
§7.7. Live cluster has populated `ownerMap` for the five active alert
classes (`real_path_dns`, `vip_readiness`, `tls_handshake`,
`relay_ats_per_ds`, `relay_ats_t3c_apply`) all routing to a shared support
alias on the Blockcast cluster. V2 (oncall-rotation, see separate spec
`2026-04-30-oncall-plugin-spec.md`) and V3 (pluggable resolver protocol)
remain on the roadmap.

#### Stub-user pitfall when routing to mailing-list aliases

If `ownerMap` resolves to an email that doesn't correspond to a real
human user (e.g. a `support@…` mailing list), the plugin's
`ctx.users.findByEmail` will only find a matching row if you've created
a "stub user" in the `user` table — and even then, `ctx.issues.create`
**also** validates the assignee against `company_memberships`. If the
membership row is missing, the plugin processes the webhook (HTTP 200,
delivery `success`) but `issues.create` throws `Assignee user not
found`, the error is caught by the per-alert try/catch, and **no issue
lands**. The webhook delivery row says success and the failure is only
visible in the worker log.

To make a stub user assignable:

```sql
-- 1. Create the stub user (no `account` row, so no login path)
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('<32-char-id>', 'CDN/Network Support', 'support@example.com', true, now(), now());

-- 2. Add membership in the target company (the validation `issues.create` does)
INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
VALUES ('<company-uuid>', 'user', '<stub-user-id>', 'active', 'member');
```

Without step 2 the alert is silently dropped from the issue pipeline.
Worth a follow-up to either expose this as an explicit error in the
plugin's webhook delivery row, or to teach `findByEmail` to surface a
"not assignable" hint that the resolver can fall through on.

Discussion that led to the decision:

Three options, mutually compatible:

- **Plugin config map** (V1): `ownerMap: { team: { platform: "alice@" } }`.
  Simple, version-controllable, rebuilds with the plugin. Doesn't scale to
  org churn — every team change requires a config rebump.
- **Kubernetes namespace ownership labels**: `ns.metadata.labels["owner-email"]`.
  Reflects org reality where deployed. Requires the alert to carry a
  `namespace` label (most do). Plugin-side: `kubectl get ns` is not a thing
  inside a plugin worker — would need a sidecar / sync job that periodically
  exports ns→owner into plugin state.
- **Linear team config**: pull "who owns Cilium" from Linear teams (which
  already have humans assigned). Couples this plugin to Linear; awkward when
  the org doesn't use Linear that way.

Recommendation taken: V1 = config map. V2 = namespace labels via a cron-driven
sync into plugin state. V3 = pluggable resolver protocol.

### Q4 — Webhook authentication

**Status: Resolved (V1) — live cluster runs `webhookTokenRef`-only auth.**
Static bearer is the V1 design. The manifest schema supports both
`webhookTokenRef` (paperclip secrets-store UUID, production posture) and
`webhookToken` (inline string, dev-mode fallback); the Alertmanager side
reads its credential from the K8s `alertmanager-receivers` Secret via
`credentials_file`. The live cluster's `plugin_config.config_json` carries
`webhookTokenRef` only — the inline `webhookToken` was stripped on
2026-04-30 after the bootstrap-fix image landed (see commit history;
the `autoConfigureAlertmanagerFromEnv` helper now short-circuits when an
operator has wired the secret-ref path).

The bearer therefore lives in three places that must rotate together:

1. `company_secrets` row in paperclip's own DB (single source of truth
   resolved through `ctx.secrets.resolve()`).
2. K8s `monitoring/alertmanager-receivers` Secret (mounted by AM as
   `credentials_file`).
3. K8s `paperclip/paperclip-alertmanager-webhook-token` Secret (env-
   injected for `autoConfigureAlertmanagerFromEnv` to seed fresh
   deploys).

The plugin README's "Bearer rotation in a Kubernetes deployment" section
spells out the rotation order.

V2 path is mTLS (deferred — heavier operational lift). IP allowlist at
ingress is documented as defense-in-depth but is not required for V1
because the receiver is ClusterIP-only.

Discussion that led to the decision:

Alertmanager itself does not sign payloads. Options:

- **Static bearer token** (V1). AM `http_config.authorization.credentials_file`
  points at a K8s secret; the plugin verifies in `onWebhook`. Simple,
  rotatable, in-cluster only.
- **mTLS**. Stronger but operationally heavier — plugin server has to
  terminate client certs.
- **IP allowlist** at ingress. Cheap, but every restart of AM reschedules its
  pod and the IP changes; would need to allowlist the whole pod CIDR.

Recommendation taken: static bearer (V1). mTLS is the V2 upgrade path.

### Q5 — Alert deduplication beyond fingerprint

AM's `fingerprint` is `hash(sorted(labels))`. Two alerts that differ only by
`pod` label have different fingerprints — desirable for "OOM on pod-a vs
pod-b are separate incidents" but undesirable for "300 pods OOM at once,
that's one issue". AM's `group_by` config solves this server-side, but a
mis-configured AM will flood the plugin.

Mitigation: rate-limit issue creation per-(alertname, severity) at the plugin
level. e.g. cap at 10 issues/min/alertname; further fires within the window
attach as comments to the most-recent open issue. Not in V1; surface as
a known limit.

### Q6 — Status-page / public visibility

If the plugin emits `plugin.alertmanager.alert.firing`, a future plugin can
post critical fires to a public status page. Should the Alertmanager plugin
itself include that, or stay narrowly-scoped? Recommend stay narrow — public
status is a separate concern.

### Q7 — Alert correlation across firings

When the same root cause produces 5 different alerts (e.g. a node going down
fires `NodeDown`, `KubeNodeNotReady`, `PodCrashLoopBackOff x N`,
`BlackboxProbeFailure`), the on-call gets 5 issues + 5 DMs. Out of scope, but
flag: the right home for correlation is upstream in AM `inhibit_rules`, not
in this plugin.

## 12. Build effort estimate

Honest hours, assuming someone fluent in the SDK (the patterns from Slack +
Linear plugins are read-once-and-go):

| Task | Hours |
|------|------:|
| Scaffold plugin from `create-paperclip-plugin` template, manifest, capabilities | 2 |
| AM v2 payload parser + Zod-style validator | 2 |
| `handleFiring` + `handleResolved` core, including state model | 4 |
| Owner resolution with caching (mirror Linear pattern) | 2 |
| Webhook auth (bearer + timingSafeEqual) | 1 |
| Issue mapping (title/description/priority/labels table) | 2 |
| `__tests__/` covering the dedup + lifecycle matrix | 4 |
| Captured-payload curl harness for stage-1 manual test | 1 |
| Docs (README + this spec → keep updated) | 2 |
| Buffer for SDK learning curve / unknown unknowns | 4 |
| **Subtotal — plugin code** | **24** |

Excluded (separate, each its own ticket):

| Out-of-scope work | Hours |
|-------------------|------:|
| Deploy Alertmanager StatefulSet + ConfigMap + Secret | 4–6 |
| Author starter `PrometheusRule` set (5 rules + the Cilium one) | 4 |
| Author `ServiceMonitor` for cilium-agent | 1 |
| Network policy + ingress for AM → Paperclip | 2 |
| Owner-map population for the actual on-call rota | 2 |
| **Subtotal — out-of-scope deploy** | **13–15** |

Total realistic hours to "the 261 GB scenario would have paged somebody":
**~37–39h** (~1 person-week with normal interruptions). Plugin alone is
~24h / 3 days of focused work.

## 13. References

- Slack plugin manifest: `packages/plugins/paperclip-plugin-slack/src/manifest.ts:10–229`
- Slack plugin event subscription pattern: `packages/plugins/paperclip-plugin-slack/src/worker.ts:1507–1525`
- Slack DM-on-assign user mapping: `packages/plugins/paperclip-plugin-slack/src/user-mapping.ts:17–50`
- Slack signature verification (model for bearer-token check): `packages/plugins/paperclip-plugin-slack/src/worker.ts:87–111`
- Linear assignee email-to-userId resolver: `packages/plugins/paperclip-plugin-linear/src/worker.ts:117–140`
- Linear `ctx.issues.create` with `assigneeUserId`: `packages/plugins/paperclip-plugin-linear/src/worker.ts:596–606`
- SDK `issues.create` schema: `packages/plugins/sdk/src/protocol.ts:804–832`
- SDK `events.emit` capability: `packages/plugins/sdk/src/protocol.ts:645`
- Alertmanager webhook config: <https://prometheus.io/docs/alerting/latest/configuration/#webhook_config>
- Alertmanager notification template data: <https://prometheus.io/docs/alerting/latest/notifications/>
- Cilium drop metrics reference: <https://docs.cilium.io/en/stable/observability/metrics/>
