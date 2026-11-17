# Paperclip Cloud sends analytics directly to PostHog

Status: proposed, 2026-11-17 (revised: Cloud uses real IDs)
PostHog project: 483530 (US), kept as the only project so history is preserved.

## Delivery state (coordinator keeps this current)

Finish line: Phases 1–3 merged with green checks and Greptile 5/5, deployed
to staging, and verified there in PostHog 483530: real IDs, server events
inside session replays, no duplicates, self-hosted output unchanged.
Production enablement is gated on the Phase 0 compliance checklist owner.

| Item | Owner | State | Evidence / link |
| --- | --- | --- | --- |
| Phase 0 A: install ID stability + Cloud ingest URL source | subagent | done. Stacks run on Railway with a `/paperclip` volume (state.json persists), except `single-ephemeral` stacks (new ID each boot). Legacy three-service stacks had ephemeral disks, and 126 of 166 live staging stacks are unclaimed warm-pool stacks: this explains the ID churn. No supported way to read state.json per stack. Env vars are set by fleet `env_config` campaigns (drain + restart; fleet keys override per-stack). `PAPERCLIP_TELEMETRY_ENDPOINT` lives in the fleet managed-env store. Staging vs production: separate fleets, and `isCloudStagingInstance()` by host. Production admin returned 401 | paperclip-cloud `src/providers/railway.ts:515-521`, `src/fleet/campaigns.ts:5545-5558`, `src/registry/model.ts:1300-1310` |
| Phase 0 B: compliance checklist status | subagent | done. Blocker for ANY production token: Terms §8 says telemetry "does not identify individual users" and Privacy §2 says "anonymized". No subprocessor list, no consent banner (website already runs GA4 + X pixel without consent), no SOC 2 program, DPA status unknown. Workspace delete (`paperclip-cloud` `SleepController.deleteStackInner`) makes no PostHog call; no self-serve account deletion | paperclip-website `web/app/terms/page.tsx:146-165`, `web/app/privacy/page.tsx:59-61` |
| Phase 0 C: PostHog entitlements | coordinator | done: session replay available pay-as-you-go ($0 now); Group analytics add-on NOT enabled (needs Dotta; not blocking because events also carry `stack_id`); product analytics projected $1,186 this period from 40.1M events, almost all OSS | PostHog billing page, 2026-11-17 |
| Phase 1: server direct sender | subagent | in progress | |
| Phase 2: browser analytics | subagent | in progress | |
| Phase 3: workspace-delete cleanup + legacy group backfill script | subagent | in progress | |
| Phase 4: staging rollout + verification | coordinator | pending | |

### Continuous deployment rule

Merged PRs roll out automatically. So every PR must be inert until its
environment switch is set, and the switches must be set in a safe order:

1. Server direct sending turns on only when `PAPERCLIP_POSTHOG_PROJECT_TOKEN`
   is set on a Cloud-managed instance. Without it, the collector path is
   unchanged.
2. Browser analytics turns on only when `PAPERCLIP_POSTHOG_BROWSER_ENABLED=1`
   is also set. Production stays off until the compliance checklist is done.
3. Fleet env vars are set with fleet `env_config` campaigns, which drain and
   restart stacks and rebuild the warm pool. Set all switches for a fleet in
   one campaign where possible.
4. Order: token on staging → verify → legacy group backfill →
   browser switch on staging → verify → **policy and terms updated** → token
   on production → browser switch on production after consent approach is in
   place.

Production gate (Phase 0 B): the current Terms §8 and Privacy §2 promise
anonymized telemetry. Even the server-side token (real user IDs) must wait
for the updated policy and terms to be live. Phase 3 also adds PostHog
workspace-scoped PostHog cleanup to workspace deletion in `paperclip-cloud`:
delete that workspace's group and the events tagged with its stack ID. It
never deletes a person, because one user can belong to several workspaces.
Person deletion happens only on account deletion, or after a check that no
other workspace still uses that person.

## Goal

1. Self-hosted (OSS) installs keep sending telemetry through the existing
   collector (`telemetry.paperclip.ing/ingest` → S3 → loader → PostHog), with
   all of the collector's anonymization. Nothing about the OSS path changes.
2. Paperclip Cloud sends its events straight to PostHog using **real
   identifiers**: workspace (stack) ID, user ID, agent ID, task ID. Anyone
   debugging can go from a PostHog event or session replay to the exact
   workspace, user and task.
3. History continues across the switch for workspaces that already exist, with
   no signing keys in Cloud infrastructure.
4. Direct sending lets Cloud use all of PostHog: page views, sessions, web
   analytics, autocapture, heatmaps, web vitals, session replay, people and
   workspace groups. Server events link to the browser session that caused
   them.

## Why the Product and Web analytics pages are empty today

- Project 483530 receives about 9.4M events per week, all server-side, all
  copied in by the telemetry backend's loader (`src/loader/sinks/posthog.mjs` in
  `telemetry-backend`).
- There is no browser SDK, so there are no `$pageview`s or sessions. Both pages
  are built on those.
- The loader sets `$process_person_profile: false` and turns off location
  lookup, so the project has no people and no locations.
- Every event already carries `deployment_source` (`oss` / `cloud`). The backend
  sets it from the request path (`V2_CLOUD_INGEST_PATH` in
  `src/v2/ingest-handler.mjs`). Cloud: ~740 installs and ~29k events per week;
  first Cloud event on 2026-09-11.

## How each existing event is built today

| PostHog field | Built by the backend as |
| --- | --- |
| `event` | Client event name, unchanged |
| `timestamp` | Client `occurredAt` |
| `distinct_id` | `HMAC-SHA256(LOADER_POSTHOG_ID_HASH_SECRET, "posthog:v1:install_id:" + sha256(rawInstallId))` |
| Dimensions | Client dimensions after enum fallback normalization. `agent_id` is HMAC-hashed by the backend; `task_id` and private source refs are salted-hashed on the client (`hashPrivateRef`) |
| Metadata | `app`, `schema_version`, `source`, `deployment_source`, `version`, `event_date`, `hour`, `ingested_at`, `normalized_properties` |
| Flags | `$process_person_profile: false`, location lookup off |

`rawInstallId` is a random UUID that the server creates on first boot and
stores in `<instance root>/telemetry/state.json`. That anonymization exists for
self-hosted users' privacy. Cloud is our own service, covered by our own terms,
and needs real IDs instead.

## Identity model on Cloud

### Real IDs from now on

| What | PostHog field | Value |
| --- | --- | --- |
| Workspace | group `workspace`, key | Raw stack ID (`PAPERCLIP_CLOUD_STACK_ID`), the same key on server and browser |
| Workspace properties | `$groupidentify` | stack slug, primary host, plan, created_at |
| Person (browser) | `distinct_id` via `identify()` | Paperclip user ID |
| Person properties | `$set` | email, name (decided 2026-11-17). Set only on the person profile, never on event properties, so deleting the person removes them |
| Server events | `distinct_id` | Acting user ID when a person triggered it; otherwise `workspace:<stackId>` |
| Server events | properties | `stack_id`, `user_id` (when known), raw `agent_id`, raw `task_id`, `company_id` |
| Browser to server link | `$session_id`, `$window_id` | Sent by posthog-js tracing headers on API requests and copied onto server events triggered by that request |

Server events with no acting person keep `$process_person_profile: false`, so
`workspace:<stackId>` never turns into a fake person. Events a user triggers
attach to that user's person record. With `$session_id` attached, those events
show up in the user's session replay timeline.

### Existing workspaces: history joined through the workspace group

Phase 0 A showed that most Cloud install IDs already changed over time:
legacy stacks had ephemeral disks, warm-pool stacks report before anyone
claims them, and single-ephemeral stacks get a new ID on every boot. There is
also no supported way to read each stack's install ID, and every per-stack
env change restarts that stack. So the plan does not keep the old
`distinct_id` on new events. It joins history through the workspace group:

- On startup the server sends `$groupidentify` for group type `workspace`,
  key `<stackId>` (the raw stack ID, the same key the browser uses), with
  `install_hash` = sha256(raw install ID). That value is not secret; it is the
  canonical install ID the collector already computes.
- A one-time operator script (in `telemetry-backend`, which owns the hashing)
  reads `install_hash` for each workspace group from PostHog, computes the old
  PostHog ID locally with the signing key from the operator's own environment,
  and writes `legacy_distinct_id` back onto the group with `$groupidentify`.
  The key never leaves that machine. No env vars, no restarts.
- HogQL joins pre-switch events (`distinct_id = legacy_distinct_id`) to the
  workspace. The script can run again after later boots to pick up new
  hashes.
- All new events use real IDs only: acting user ID, else `workspace:<stackId>`.
- Known cost: a one-time step in "unique installs" counts on cutover day,
  because events with no acting person switch from the old ID to
  `workspace:<stackId>`.

What doesn't carry over: per-agent and per-task history before the switch,
because those were hashed. Old `agent_id` and `task_id` values stay hashed;
new ones are raw. Agent- and task-level questions are almost always about
recent work, so this plan accepts the break.

## Architecture after the change

```
OSS server ──► collector /ingest ──► S3 ──► loader ──► PostHog 483530   (unchanged, anonymized)

Cloud server ──► posthog-node (direct, real IDs) ─────► PostHog 483530
Cloud browser ─► posthog-js (direct, via our proxy) ──► PostHog 483530
                  └─ tracing headers ──► Cloud server (links events to sessions)
```

Each event name has exactly one sender. A process sends a given batch either to
the collector or directly to PostHog, never both.

## Work plan

### Phase 0: confirm and decide (no code)

- [ ] Compliance checklist (owner: whoever owns Cloud compliance; not legal
      advice):
  - Privacy policy names PostHog as a processor and covers product analytics
    and session recording.
  - PostHog data processing agreement signed. The US region relies on Standard
    Contractual Clauses or the EU–US Data Privacy Framework for EU users.
  - Consent approach for EU visitors: a banner, or cookieless mode until the
    visitor consents.
  - PostHog access goes through SSO, least privilege, and limited access to
    replays. Retention periods set. PostHog added to the SOC 2 vendor list.
- [x] Check whether install IDs survive redeploys on Cloud. Result: mostly
      yes now, but historically no (see the state table).
- [ ] Find where Cloud stacks get the Cloud ingest URL (`V2_CLOUD_INGEST_PATH`);
      it is not in `paperclip-cloud` source. The direct sender replaces it.
- [ ] Check the PostHog plan for group analytics (paid add-on) and session
      replay quotas.

### Phase 1: server sends directly on Cloud (paperclip repo, one PR)

- Add a direct sending path to `TelemetryClient`. When the server is Cloud
  (`isCloudManagedInstance()`) and `PAPERCLIP_POSTHOG_PROJECT_TOKEN` is set,
  batches go to PostHog through `posthog-node` (loaded with dynamic `import()`,
  so self-hosted installs never load it). Otherwise behavior is unchanged.
- On the direct path, typed helpers skip anonymization (`hashPrivateRef`) and
  add `stack_id`, `user_id` and `company_id`. Event names, dimension names and
  enum normalization stay identical to the collector path, so insights keep
  working.
- Keep `deployment_source: "cloud"`, `app`, `version`, `schema_version` and
  `source`, so filters built on today's properties keep working.
- Request context: an Express middleware reads posthog-js tracing headers
  (`X-POSTHOG-SESSION-ID`, `X-POSTHOG-WINDOW-ID`, `X-POSTHOG-DISTINCT-ID`). Only
  on Cloud, it stores them in request-scoped context so events emitted during
  that request carry `$session_id` and the acting user.
- `install_hash` on the startup `$groupidentify`, as described above.
- Flush on shutdown so deploy restarts don't drop queued events.
- Kill switch: `PAPERCLIP_POSTHOG_DIRECT=0` sends through the collector again.
- Tests:
  - Self-hosted installs (no Cloud env) never import `posthog-node`, keep
    posting to `/ingest`, and still hash private refs.
  - On Cloud: real IDs, group, `install_hash` only on the group.
  - No double sending: one batch goes to exactly one sender.
  - Session headers are ignored on self-hosted installs.

### Phase 2: browser analytics on Cloud (paperclip repo, one PR)

- Server sends `{ token, apiHost }` to the UI in the existing instance or health
  bootstrap response, only when the server is Cloud, the token is set, and
  `PAPERCLIP_POSTHOG_BROWSER_ENABLED=1`. A token alone leaves browser
  analytics off (tested). The
  token is never baked in at build time, because the same UI ships in the OSS
  npm package.
- The UI loads `posthog-js` with dynamic `import()` after first paint, and only
  when it receives a token. This keeps cold loads in the OSS and Cloud bundles
  as fast as they are today.
- `posthog.init` settings:
  - pageviews on history changes, pageleave, autocapture, web vitals, heatmaps
  - `person_profiles: "identified_only"`
  - tracing headers on our own API host only
  - every event also gets `deployment_source: "cloud"` and `environment`
- After sign-in: `identify(userId, props)` and
  `group("workspace", stackId, props)`. On sign-out: `reset()`.
- Session replay is on, with all inputs masked. Text is masked by default inside
  customer-content areas (task bodies, chat, documents, artifacts), using a
  shared mask wrapper.
- Reverse proxy: serve PostHog through our own Cloud domain so ad blockers don't
  drop events.
- Test that the UI never calls `posthog.capture()` with an event name from
  `PAPERCLIP_EVENTS`, to keep one sender per event.
- Per-workspace switch to turn off session replay, or all browser analytics,
  for customers whose contracts forbid recording.
- Account deletion also deletes the person in PostHog (through the PostHog
  persons API, from the server).
- Masking and autocapture defaults never capture input values. Secret and
  credential fields are always excluded (`ph-no-capture`).

### Phase 3: workspace cleanup and legacy group backfill (paperclip-cloud PR + telemetry-backend PR)

- paperclip-cloud: workspace deletion deletes that workspace's PostHog group
  and the events tagged with its stack ID. It never deletes a person. It is
  inert until a PostHog personal API key is configured in the control plane.
- telemetry-backend: the legacy group backfill script described above, with a
  dry-run mode and a count of workspaces matched and skipped.
- Fleet env vars are set by the coordinator during Phase 4 with fleet
  `env_config` campaigns: `PAPERCLIP_POSTHOG_PROJECT_TOKEN`,
  `PAPERCLIP_POSTHOG_HOST`, `PAPERCLIP_POSTHOG_ENVIRONMENT`, and later
  `PAPERCLIP_POSTHOG_BROWSER_ENABLED`. No signing keys.
- Keep the Cloud ingest URL setting while the `PAPERCLIP_POSTHOG_DIRECT=0`
  rollback is supported. Rollback relies on it to reach the Cloud path and
  keep the `cloud` label.

### Phase 4: rollout

1. Staging stacks first, for 24 hours:
   - Events show real IDs.
   - Workspace groups carry `install_hash`, and after the backfill,
     `legacy_distinct_id` joins pre-switch events.
   - Server events triggered from the UI show up in that user's session replay.
   - No duplicate uuids.
   - Per-hour counts are within normal variance.
2. Production, by turning on direct sending through fleet config. No Paperclip
   release is needed to switch back.
3. In PostHog, set the project's internal/test filter to exclude
   `environment = staging`.
4. Optional cleanup, only after the `PAPERCLIP_POSTHOG_DIRECT=0` rollback is
   retired: remove the Cloud ingest URL setting and the backend's Cloud
   ingest path.

## Success criteria

- [ ] The Web analytics and Product analytics pages for 483530 show Cloud
      visitors, sessions, pages and countries, and no self-hosted traffic.
- [ ] Given a user ID or stack ID, you can find that user's or workspace's
      events, sessions and replays in PostHog, including server events from
      their session.
- [ ] For workspaces that existed before the switch, pre-switch events can be
      joined to the workspace through `legacy_distinct_id` on its group.
- [ ] No signing key is stored anywhere in Cloud infrastructure.
- [ ] No duplicate events: `count() = uniq(uuid)` for Cloud events on cutover
      day.
- [ ] Self-hosted traffic is unchanged in volume, shape and anonymization.
      Self-hosted builds never load `posthog-node` or `posthog-js`.
- [ ] Session replays play back with customer content masked.
- [ ] Cold load time on Cloud is not measurably worse (before/after numbers).

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Real IDs leak into the OSS path | Direct-path-only code branch; tests that self-hosted output stays hashed |
| Install IDs weren't stable on Cloud | History joins through the workspace group; new events use the stack ID, which is stable |
| Customer content or pasted secrets show up in replays or autocapture | Mask all inputs and content areas by default; exclude credential fields; review sample replays before production |
| A deletion request leaves PII behind | Email and name only on person profiles; account deletion deletes the PostHog person |
| An enterprise customer forbids recording | Per-workspace replay and analytics switch |
| Tracing headers spoofed by a client | Used only to link to a session, never to authorize; acting user comes from the authenticated request, not the header |
| Ad blockers drop browser events | First-party reverse proxy |
| Events lost on deploy restarts | Flush on shutdown; posthog-node retries |
