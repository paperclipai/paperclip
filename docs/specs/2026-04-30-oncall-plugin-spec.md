# paperclip-plugin-oncall — design spec

Status: **Draft.** Not implemented.
Owner: TBD
Drives: alertmanager-plugin Q3 V2 (the rotation mechanism behind
`ownerMap`).

## 1. Why

The Alertmanager plugin's V1 `ownerMap` resolves a label key/value pair
to a static email. That email is fine for individual owners but breaks
for "current oncall" routing: the person who *owns* an alert class is
not always the person who *should be paged at this exact moment*. Today
the workaround is a mailing-list alias (e.g. `support@blockcast.net`)
backed by a paperclip stub user with a `company_memberships` row — see
the alertmanager-plugin spec §11 Q3 — but that has no audit trail of who
was actually oncall when an issue opened, and the alias's membership has
to be maintained in an external directory tool.

This plugin owns "who is oncall for team X right now" as a first-class,
auditable fact inside Paperclip. Other plugins consume it.

## 2. Goal

- Resolve `team → current oncall email` consistently across plugins.
- Audit trail: which person was oncall when each issue opened, queryable.
- No external dependencies for V1. (PagerDuty / Opsgenie are V2 of V2.)
- One-week lead time on a "Bob is covering for Alice next week" override.

## 3. Non-goals

- Replacing PagerDuty / Opsgenie scheduling. We integrate with them in V2
  for orgs that already use them; we don't compete with them.
- Generic "calendar overlay" features (vacations, OOO, holidays, etc.).
  Captured at most as one-off overrides.
- Real-time mobile escalation. That's the job of an external pager;
  this plugin just answers "who".
- Cross-plugin RPC machinery. Stick to shared plugin state for now —
  the simplest pattern other plugins already speak.

## 4. Architecture

```
┌─────────────────────┐  cron (5m)        ┌──────────────────────┐
│  paperclip-plugin-  │ ─────────────────►│  plugin_state        │
│      oncall         │                   │  (instance scope)    │
│                     │                   │  oncall:cdn = "..."  │
│  job:               │                   │  oncall:platform=".."│
│   recomputeOncall   │                   └──────────┬───────────┘
└─────────────────────┘                              │
        ▲                                  read      │
        │  emits                            ◄────────┘
        │  oncall.rotation.changed                   │
        ▼                                            │
┌─────────────────────┐                   ┌──────────▼───────────┐
│  paperclip-plugin-  │  webhook fires    │  paperclip-plugin-   │
│      slack          │  ◄──────────────  │     alertmanager     │
│  (DM the new        │                   │  ownerMap[team:cdn]  │
│   oncall on flip)   │                   │   → state.get(...)   │
└─────────────────────┘                   └──────────────────────┘
```

- **Single plugin** owns the rotation schema and computes "current".
- **Plugin instance config** carries the rotation list and cadence.
- **Cron job** (built into the plugin, runs every 5 min) recomputes the
  current oncall for each team and writes `oncall:<team>` plugin state
  keys. State writes are idempotent — most ticks are no-ops.
- **Other plugins read** the shared plugin state to look up current
  oncall. No new SDK surface; uses the same `ctx.state.get()` they
  already use.
- **Rotation flip events** (`oncall.rotation.changed`) emit on the cron
  tick that detects a transition. Slack plugin can subscribe to DM the
  new oncall a "you're up" message.

## 5. Schema (`instanceConfigSchema`)

```yaml
teams:
  cdn:
    rotation:
      - alice@example.com
      - bob@example.com
      - carol@example.com
    cadence: weekly      # weekly | daily | <Nh> | <Nd>
    anchor: 2026-01-01T00:00:00Z   # week 0 starts here, in `timezone`
    timezone: UTC        # IANA name; default UTC
  platform:
    rotation: [...]
    cadence: weekly
    anchor: 2026-01-01T00:00:00Z

overrides:
  # one-off "Bob's covering for Alice this week"
  - team: cdn
    from: 2026-04-29T00:00:00Z
    to:   2026-05-06T00:00:00Z
    email: bob@example.com
    reason: "alice is OOO"
    createdBy: omar@example.com
    createdAt: 2026-04-28T10:00:00Z
```

Validation:

- `rotation` must have ≥1 entry, all valid email format.
- `cadence` is either an enum (`weekly`, `daily`) or `Nh`/`Nd`.
- `anchor` is RFC3339, must be ≤ now (no future-anchored rotations in V1).
- `timezone` is an IANA name; default UTC.
- `overrides` are appended/edited via the same instance-config UI; no
  separate write API in V1.

## 6. Resolution algorithm

For each team, on every cron tick (and on-demand for the resolver
helper):

1. **Active override.** If any `overrides[i]` matches `team` and `now`
   in `[from, to)`, return `overrides[i].email`.
2. **Compute period index.**
   `period = floor((now - anchor) / cadence_duration)` — both sides in
   the team's timezone.
3. **Index into rotation.** `email = rotation[period mod len(rotation)]`.
4. Return `email`.

Edge cases:

- `now < anchor` → return rotation[0] with a warning logged.
- Empty rotation (config error) → return undefined; alertmanager-plugin
  treats as "no oncall configured" and falls through to the original
  static `ownerMap` value (see §8).
- Multiple overlapping overrides → use the most-recently-`createdAt`
  one. Log a warning so the operator sees the conflict.

## 7. Integration

### 7.1 alertmanager-plugin: indirect ownerMap entries

`ownerMap` values become a tagged union:

```ts
type OwnerMapValue =
  | string                          // V1: static email
  | { team: string };               // V2: indirect via oncall plugin
```

Worker resolution:

```ts
const v = ownerMap[labelKey]?.[labelValue];
if (typeof v === "string") return resolveOwnerEmail(v, ...);
if (v && typeof v.team === "string") {
  const oncallEmail = await ctx.state.get(
    { scopeKind: "instance", stateKey: `oncall:${v.team}` },
  );
  if (typeof oncallEmail === "string" && oncallEmail.length > 0) {
    return resolveOwnerEmail(oncallEmail, ...);
  }
  return { email: null, source: "no-oncall-data" };
}
```

The shared-state read is idiomatic. No new SDK surface.

### 7.2 slack-plugin: DM on rotation flip

Subscribes to `plugin.oncall.rotation.changed`. Payload:

```json
{
  "team": "cdn",
  "from": "alice@example.com",
  "to": "bob@example.com",
  "effectiveAt": "2026-05-06T00:00:00Z",
  "reason": "scheduled rotation"
}
```

Slack plugin DMs Bob: "You're up as cdn oncall starting 2026-05-06" with
a link to the team's rotation in the paperclip UI.

### 7.3 Issue-creation audit trail

Alertmanager-plugin already writes `assigneeUserId` on issue creation.
With this plugin, the `AlertStateRecord` (in alertmanager-plugin's plugin
state) gets a new optional field:

```ts
oncallContext?: {
  team: string;        // resolution source: "oncall:cdn"
  email: string;       // who was oncall at creation time
  resolvedAt: string;  // RFC3339
};
```

So even after the rotation flips, the issue's history shows who was
oncall when it opened.

## 8. Cron cadence

- Recompute every 5 min. Cheap: O(teams) per tick.
- On rotation boundary (e.g. weekly = midnight UTC Sunday → Monday in the
  team's timezone), state key flips and the change event emits exactly
  once.
- Emit-once-per-flip is enforced by remembering the last-emitted email
  per team in plugin state alongside the current-oncall key.

## 9. Three-stage rollout

### Stage 1 — schema + resolver (no integrations)

- Schema validation
- Cron job that writes `oncall:<team>` keys
- Unit tests for resolution algorithm + override semantics
- No event emission yet
- No alertmanager integration yet

### Stage 2 — alertmanager integration

- Extend `ownerMap` to accept `{ team: ... }` indirect entries
- Add `oncallContext` to `AlertStateRecord`
- Migration path for existing `ownerMap`: indirect entries are net-new;
  static-email entries keep working as-is

### Stage 3 — flip notifications

- Emit `plugin.oncall.rotation.changed`
- Slack plugin subscribes (separate PR in slack-plugin)
- UI: minimal view of "current oncall per team" in the paperclip
  settings page for the plugin

## 10. Open questions

### Q1 — Where does rotation config live?

- **Plugin instance config** (V1, proposed): plain JSON in
  `plugin_config.config_json`, edited via the existing settings UI.
  Pros: version-controllable when serialized; existing infrastructure.
  Cons: editing rotations becomes an engineer-only flow.
- **Dedicated table** (`oncall_team_rotations`, `oncall_overrides`):
  proper schema with FKs to users; allows non-engineers to edit via a
  custom UI.

Recommendation: V1 config; promote to dedicated table when the team
list and override frequency justify a custom UI.

### Q2 — Timezone handling

Per-team timezone is necessary for orgs with regional handoffs ("APAC
oncall flips at 09:00 Asia/Singapore"). V1 supports per-team
`timezone`. Global UTC default is fine for most.

### Q3 — Notification on rotation change

V1 emits the event. Whether anyone subscribes is up to the slack-plugin
(or future pagerduty-plugin). Spec is mute on UX choices like "DM the
incoming oncall vs both incoming and outgoing".

### Q4 — PagerDuty / Opsgenie pluggability

For orgs that already use PD/OG, `oncall:<team>` could be sourced from
their schedule API instead of the plugin's own rotation list. Schema:

```yaml
teams:
  cdn:
    source:
      type: pagerduty
      scheduleId: PXYZ123
      apiKeyRef: <secret-uuid>
```

Out of scope for V1; surface as a tagged-union extension in the schema.

### Q5 — Override audit log

V1 stores overrides in instance config. Edits overwrite. No history of
"who set up this override and when" beyond the inline `createdBy` /
`createdAt`. Acceptable for V1; rotate to a dedicated table when (Q1)
gets promoted.

### Q6 — Multi-company isolation

Plugin instance config is per-company already. State writes use
`scopeKind: "instance"`. Different companies' oncall schedules don't
collide.

### Q7 — Can the alertmanager-plugin read state from a sibling plugin?

Plugin state has scope `(plugin, scopeKind, scopeId, namespace, key)`.
The alertmanager-plugin would need to read state owned by the
oncall-plugin. Either:

- Treat `oncall:<team>` keys as a **well-known cross-plugin namespace**.
  Requires SDK support for "shared state" or just convention + lookup
  by `(plugin_key='paperclip-plugin-oncall', state_key='oncall:cdn')`.
- Or the oncall-plugin emits + the alertmanager-plugin caches.
  Eventually-consistent. Simpler in the SDK; more state in the consuming
  plugin.

V1: shared-state read by convention. Document the namespace.

## 11. Build effort estimate

| Stage | Hours |
|---|---|
| Stage 1 — schema + resolver + cron | 3 |
| Stage 2 — alertmanager integration | 1.5 |
| Stage 3 — flip notifications + minimal UI | 2 |
| Total to ship V1 | ~6.5 |

## 12. References

- alertmanager-plugin spec §11 Q3 — V1 owner-map decision and the
  stub-user pitfall this plugin sidesteps.
- Slack plugin's `issue.created` listener — same hooking pattern that
  `oncall.rotation.changed` uses.
