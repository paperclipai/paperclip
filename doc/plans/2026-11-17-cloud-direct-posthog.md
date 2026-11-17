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
| Phase 0 A: install ID stability + Cloud ingest URL source | subagent | in progress | |
| Phase 0 B: compliance checklist status | subagent | done. Blocker for ANY production token: Terms §8 says telemetry "does not identify individual users" and Privacy §2 says "anonymized". No subprocessor list, no consent banner (website already runs GA4 + X pixel without consent), no SOC 2 program, DPA status unknown. Workspace delete (`paperclip-cloud` `SleepController.deleteStackInner`) makes no PostHog call; no self-serve account deletion | paperclip-website `web/app/terms/page.tsx:146-165`, `web/app/privacy/page.tsx:59-61` |
| Phase 0 C: PostHog entitlements | coordinator | done: session replay available pay-as-you-go ($0 now); Group analytics add-on NOT enabled (needs Dotta; not blocking because events also carry `stack_id`); product analytics projected $1,186 this period from 40.1M events, almost all OSS | PostHog billing page, 2026-11-17 |
| Phase 1: server direct sender | subagent | in progress | |
| Phase 2: browser analytics | subagent | in progress | |
| Phase 3: fleet config + legacy IDs | subagent | waiting on Phase 0 A | |
| Phase 4: staging rollout + verification | coordinator | pending | |

### Continuous deployment rule

Merged PRs roll out automatically. So every PR must be inert until its
environment switch is set, and the switches must be set in a safe order:

1. Server direct sending turns on only when `PAPERCLIP_POSTHOG_PROJECT_TOKEN`
   is set on a Cloud-managed instance. Without it, the collector path is
   unchanged.
2. Browser analytics turns on only when `PAPERCLIP_POSTHOG_BROWSER_ENABLED=1`
   is also set. Production stays off until the compliance checklist is done.
3. `PAPERCLIP_POSTHOG_LEGACY_DISTINCT_ID` must be set on every existing stack
   before its token is set. Otherwise that stack's history breaks.
4. Order: legacy IDs on all stacks (inert) → token on staging → verify →
   browser switch on staging → verify → **policy and terms updated** → token
   on production → browser switch on production after consent approach is in
   place.

Production gate (Phase 0 B): the current Terms §8 and Privacy §2 promise
anonymized telemetry. Even the server-side token (real user IDs) must wait
for the updated policy and terms to be live. Phase 3 also adds PostHog
group/person deletion to workspace deletion in `paperclip-cloud`.

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
| Workspace | group `workspace`, key | Stack ID (`PAPERCLIP_CLOUD_STACK_ID`) |
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

### Existing workspaces: one precomputed variable, no secrets in the fleet

The only thing that needs the old hashed form is continuity of `distinct_id`
for workspaces that existed before the switch.

- A one-time operator script reads each live Cloud stack's
  `telemetry/state.json` install ID. It computes the old PostHog ID locally,
  using the signing key from the operator's own environment, and writes it to
  the stack as `PAPERCLIP_POSTHOG_LEGACY_DISTINCT_ID`. The key is used on one
  machine, once, and never stored in the fleet, the stack or Paperclip.
- On a stack that has the variable, the server:
  1. Sends `$groupidentify` for `workspace:<stackId>` with
     `legacy_distinct_id`. HogQL can then join pre-switch events to the
     workspace.
  2. Keeps sending events with no acting person under the legacy ID, so
     "unique installs" insights stay continuous. Everything else (group, user,
     real dimension values) uses real IDs.
- New stacks never get the variable and use real IDs only.
- Later, once nobody needs install-level continuity, delete the variable and
  those stacks switch to `workspace:<stackId>` too. The group mapping keeps the
  history joinable.

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
- [ ] Check whether install IDs survive redeploys on Cloud (999 IDs since
      2026-09-11, 672 active on one day only). If they don't, legacy continuity
      is already broken, and the legacy variable is only worth setting for the
      stable ones.
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
- Legacy handling as described above, driven by
  `PAPERCLIP_POSTHOG_LEGACY_DISTINCT_ID`.
- Flush on shutdown so deploy restarts don't drop queued events.
- Kill switch: `PAPERCLIP_POSTHOG_DIRECT=0` sends through the collector again.
- Tests:
  - Self-hosted installs (no Cloud env) never import `posthog-node`, keep
    posting to `/ingest`, and still hash private refs.
  - On Cloud: real IDs, group, legacy ID used only when the variable is set.
  - No double sending: one batch goes to exactly one sender.
  - Session headers are ignored on self-hosted installs.

### Phase 2: browser analytics on Cloud (paperclip repo, one PR)

- Server sends `{ token, apiHost }` to the UI in the existing instance or health
  bootstrap response, only when the server is Cloud and the token is set. The
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

### Phase 3: Cloud fleet config and legacy backfill (paperclip-cloud, one PR + one script run)

- Fleet variables: `PAPERCLIP_POSTHOG_PROJECT_TOKEN`, `PAPERCLIP_POSTHOG_HOST`,
  `PAPERCLIP_POSTHOG_ENVIRONMENT` (`staging` / `production`). No signing keys.
- One-time script: for each live stack, read the install ID, compute the legacy
  ID locally, and set `PAPERCLIP_POSTHOG_LEGACY_DISTINCT_ID` on that stack.
  Record how many stacks were set and how many were skipped.
- Remove the Cloud ingest URL setting once direct sending is live everywhere.

### Phase 4: rollout

1. Staging stacks first, for 24 hours:
   - Events show real IDs.
   - Legacy stacks keep their old `distinct_id` for events with no acting
     person.
   - Server events triggered from the UI show up in that user's session replay.
   - No duplicate uuids.
   - Per-hour counts are within normal variance.
2. Production, by turning on direct sending through fleet config. No Paperclip
   release is needed to switch back.
3. In PostHog, set the project's internal/test filter to exclude
   `environment = staging`.
4. Optional cleanup: once no `deployment_source = cloud` events reach the
   collector for 7 days, remove the backend's Cloud ingest path.

## Success criteria

- [ ] The Web analytics and Product analytics pages for 483530 show Cloud
      visitors, sessions, pages and countries, and no self-hosted traffic.
- [ ] Given a user ID or stack ID, you can find that user's or workspace's
      events, sessions and replays in PostHog, including server events from
      their session.
- [ ] Workspaces that existed before the switch keep their `distinct_id` for
      events with no acting person: no rise in new Cloud IDs on cutover day.
      Pre-switch events can be joined to the workspace through
      `legacy_distinct_id`.
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
| Install IDs aren't stable on Cloud | Phase 0 check; set the legacy variable only where it helps |
| Customer content or pasted secrets show up in replays or autocapture | Mask all inputs and content areas by default; exclude credential fields; review sample replays before production |
| A deletion request leaves PII behind | Email and name only on person profiles; account deletion deletes the PostHog person |
| An enterprise customer forbids recording | Per-workspace replay and analytics switch |
| Tracing headers spoofed by a client | Used only to link to a session, never to authorize; acting user comes from the authenticated request, not the header |
| Ad blockers drop browser events | First-party reverse proxy |
| Events lost on deploy restarts | Flush on shutdown; posthog-node retries |
