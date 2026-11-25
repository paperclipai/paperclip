# Google Antigravity: from pending candidate to qualified harness — 2026-11-22

Continues [the October integration plan](2026-10-28-antigravity-integration.md).
That document remains the historical ledger for the macOS candidate. This one
is the current release contract and acceptance ledger.

## Release contract

| Decision | Answer |
| --- | --- |
| User outcome | An operator picks Google Antigravity, binds a Google credential, picks a model (including Gemini 4 Neon at any offered thinking level) and assigns ordinary work, locally or in a cloud sandbox. |
| Native route | Google's official Antigravity ACP server through the existing ACPX driver. |
| Runtime pin | ACP server **1.5.2** (registry commit `e29b5bf3bf`, 2026-11-21), two-executable closure, owned admission patch re-ported. |
| Platforms | Target: linux-x64 (Daytona) and darwin-arm64 (local), both verified and started natively, neither yet live-qualified (see ledger). linux-arm64: static verification only, never started. darwin-x64: inventory-only (no native host). |
| Authentication | `gemini-api-key` (local and remote) and personal Google sign-in (local). Agent Platform (Vertex/ADC) and remote OAuth: see open decisions. |
| Models | Caller-selected, read from the account or server catalog. No product allowlist. Thinking level is part of the model ID (`<family>-<level>`, levels `minimal/low/medium/high/extra_high`). |
| Release target | One reviewable PR with green checks; merge and production flip are separate decisions. |
| Deployment policy | Unchanged: `PAPERCLIP_AVAILABLE_HARNESSES` stays the deployment's choice. |

## Verified upstream facts (2026-11-22)

- Registry is at 1.5.2; all four archive checksums match the registry.
- Linux `.par` is an ELF launcher with a Python 3.14 zip appended. macOS `.par`
  is a signed Mach-O. The helper `localharness_external` is unchanged in role.
- In 1.5.2 a bare `GEMINI_API_KEY` no longer selects an auth method; `auth.type`
  in settings or an `authenticate` call is required.
- **All four `gemini-4-*` families are marked `agent_platform_only` in the
  server's built-in catalog.** In `gemini-api-key` mode the server lists only
  the Flash families and 3.1 Pro. Google's "Neon with API keys" note (Nov 20) is
  for the Antigravity App, not this ACP release.
- The Gemini Developer API lists `gemini-4-neon` for our test key, but the key is
  free tier with a Neon quota of 0.
- Patch `1.5.2-paperclip.2` adds exact-model admission, so a requested API-key
  model ID (Gemini 4 and Neon included) is admitted with an exact receipt despite
  the built-in `agent_platform_only` marking. Inference is a separate question.
- The ACP layer exposes no Orchestrator mode.

## Swarm (`/swarm`) and Orchestrator (2026-11-23)

These are two different features. The pinned 1.5.2 ACP server offers neither.

- **Orchestrator** is a model choice ("Orchestrator (Neon)": Neon plans,
  Hydrogen implements). The 1.5.2 server lists no Orchestrator entry in its
  model picker.
- **`/swarm`** is a slash command. It turns the conversation into a
  coordinator that adds named workers and a verifier. The members talk on a
  shared message board. Workers share the workspace or get their own working
  copy. Google's docs list it for the Antigravity App and the Antigravity CLI
  only, on all plans. It does not need Neon: workers use the conversation's
  model. Sources: [Swarm](https://antigravity.google/docs/swarm),
  [Slash commands](https://antigravity.google/docs/slash-commands), App
  changelog 2.31.0 (2026-11-09).
- The 1.5.2 server (registry entry `antigravity-acp`, the IDE-extension
  server) does not offer `/swarm`:
  - Live `available_commands_update` after `session/new` lists only `plan`,
    `logout` and `usage`. Session modes are `default`, `auto_edit` and
    `yolo`. Config options are `model`, `thinking_level` and `mode`.
  - The bundled SDK knows one built-in slash command (`plan`). Its built-in
    tool list has no swarm or board tools. The server sends `/swarm` text to
    the model as ordinary prompt text.
  - The helper `localharness_external` contains swarm code behind
    `enable-native-swarm` flags, but the 1.5.2 server does not enable it.
- Google now documents `agy acp` (part of the Antigravity CLI) as the ACP
  route, and says CLI slash commands appear in the client's command menu.
  Paperclip does not use `agy acp`. Whether `agy acp` offers `/swarm` is not
  verified.
- Paperclip side: the task prompt is one JSON line, so `/swarm` in a task
  never starts a prompt line and the slash-command guard does not fire. In a
  local run on Gemini 3.8 Flash (Google sign-in), the agent read `/swarm` as a
  plain request. It hired three new agents and made three subtasks with
  Paperclip's own tools. No native swarm started. The parent task finished
  after five successful runs across four agents (about 270k input tokens);
  one verifier run failed with a provider error and its retry passed.

### Antigravity CLI route: distribution only (experimental, 2026-11-23)

A second distribution, Google's Antigravity CLI (`agy`) 1.5.15, build
`1.5.15-5514532022517760`, is pinned for darwin-arm64, linux-x64 and
linux-arm64 in `packages/paperclip-runner/antigravity-cli-distributions.json`.
It is the route for native `/swarm` (experimental, off by default; see
"/swarm on the Antigravity CLI" below).

- **Experimental.** It is not part of the registry-server profile above and
  changes none of its pins, its admission patch or its qualification state.
- **Fetched at setup time.** Setup downloads the archive from Google's
  versioned URL and checks it against the pinned size, SHA-512 and SHA-256. It
  then checks the extracted executable's SHA-256 and SHA-512. It installs into
  `~/.paperclip/runtimes/antigravity-cli/`, beside the registry-server runtime.
  Any mismatch installs nothing. The provider pack and Docker images do not
  carry the binary. The reasons are that Google publishes no redistribution
  licence for the CLI and that the bucket's object immutability cannot be
  checked anonymously.
- **Integrity without a patch.** The CLI is one signed Go binary with no patch
  point, so the owned admission patch cannot apply. Integrity is the pinned
  archive plus the pinned executable. Each launch runs the sealed-store copy
  and re-hashes the executable it spawns. Self-update is off through the pinned
  environment `AGY_CLI_DISABLE_AUTO_UPDATE=1`. The endpoint, `--gemini-dir`,
  modes and other flags are driver policy and are not pinned here.

## Swarm channel (2026-11-24)

The swarm route runs Google's Antigravity CLI (`agy acp`). On one paid sign-in,
the CLI's default channel (`daily-cloudcode-pa`, the one Google's app and CLI
use) offered 27 models, including Gemini 4 Neon at four levels, and answered a
Neon prompt. Google's stable endpoint (`cloudcode-pa`) offered 13 models and
no Neon, and its CLI quota pool (project `default-cli-project`, consumer
sign-in) was exhausted while the same account's ordinary route answered.

- The deployment chooses the channel with the server environment variable
  `PAPERCLIP_ANTIGRAVITY_SWARM_CHANNEL`: `provider_default` (default; no
  endpoint override, so the pinned CLI uses Google's default channel, which is
  not Google's stable channel and can change with less notice) or `stable`.
- The swarm's start step names the channel, and the run's diagnostics record
  it and whether the CLI's own sign-in is the agent's Google connection
  (`matches`, `does_not_match` or `unknown`). The CLI shows its account only in
  its own log; the Runner compares digests and never records the account.
- A usage limit on the swarm route holds only further swarms (quota scope
  `antigravity_cli`); ordinary work on the same account continues.

## Routes to Neon

State as of the end of 2026-11-22. "Admitted" means the patched server returned
an exact-model receipt for the requested ID without sending a prompt; it is not
evidence that Google serves inference for that model on that credential.

| Route | State | Needs |
| --- | --- | --- |
| API key (exact-model admission in patch `1.5.2-paperclip.2`) | All four Neon levels admitted prompt-free with exact receipts on macOS and Linux x64; no `AGY_ACP_DEFAULT_MODEL` needed. No Neon prompt has completed: the only key is free tier (Neon quota 0) | A paid Gemini key, then one accepted prompt per level |
| Personal Google sign-in (subscription catalog) | Local macOS sign-in journey proven on 1.4.3 (October). On 2026-11-25 (local darwin-arm64, subscription sign-in): ordinary tasks completed on Gemini 4 Neon at all four levels and a `/swarm` completed on Neon (Low), each with requested = effective model (see the acceptance ledger). Never offered in a cloud sandbox | The same in a cloud sandbox |
| Agent Platform (Vertex/ADC) | Advertised by the server, never exercised here | A Google Cloud project and service credentials |

## Workstreams

1. **Runtime 1.5.2 and cross-platform closure.** Bump the pin; port the patch to
   1.5.2 on Mach-O and ELF; per-platform helper identity; four-platform
   distribution declaration; version checks; regenerate profiles; widen the
   platform gates in the runner, Rust and the sidecar schema. Proof: clean
   provisioning plus native initialize, API-key authenticate and one Flash prompt
   on darwin-arm64 and linux-x64.
2. **Test catalog and CI.** Antigravity API-key profile, a qualification suite on
   the Kimi pattern (local and Daytona), stop/lifecycle/provider-death cases, CI
   matrix wiring for `GEMINI_API_KEY`, unit coverage of the catalog.
3. **API-key connection and models.** Model discovery for API-key connections,
   Neon and thinking-level projection, model audit, Neon route chosen above.
4. **Remote execution.** Provider pack and Daytona image carry the Linux
   closure; lift the executor's remote/warm gates for the API-key route; remote
   credential home.
5. **Lifecycle gates.** Loaded-session admission, Stop, questions and
   permissions, durable recovery (today it throws), provider-death expiry.
6. **Qualification flip and review.** Flip the four pending declarations on the
   Kimi template, update UI/CLI/docs/maps, run the acceptance matrix and the
   existing evals under the native Runner, record results here.

Order: 1 and 2 in parallel; then 3, 4 and 5; then 6.

## Acceptance ledger

Profile state: **pending**. The qualification flip has not happened and must
not happen until every row marked NOT RUN below has passed live.

**First prompts completed on 1.5.2 on 2026-11-23, local darwin-arm64 only,
Google sign-in route, model `gemini-3.8-flash-low`** (see "First live tasks"
below). The API-key route has still not completed a prompt: the only Gemini
key available is free tier, and Google answered every attempt with 503
(overloaded) or 429 (`RESOURCE_EXHAUSTED`). Rows that need another model, the
API-key route or Daytona remain NOT RUN, not failed and not passed.

| Gate | Required observation | Verdict (2026-11-22) |
| --- | --- | --- |
| Runtime pin | ACP server 1.5.2 with owned patch `1.5.2-paperclip.2`, closures re-pinned | Done |
| Distribution | Clean setup verifies vendor and patched closures on each claimed platform; tamper rejected | darwin-arm64: verified and started natively. linux-x64: provisioned and started natively in Daytona. linux-arm64: static verification only, never started. darwin-x64: not supported |
| Remote provider pack | Pack carries the Linux closure; server's remote path verifies it | Passed for linux-x64 through the server's remote path in Daytona. Re-verification on a reused sandbox lease 4.3 s → ~0.25 s |
| API-key auth | Native `gemini-api-key` session reaches an exact-model receipt | Passed live on macOS and Linux x64 (receipt only; no prompt) |
| Model admission | Every model ID admitted by exact-model admission, prompt-free | Passed: all 28 IDs (14 Gemini 3, 14 Gemini 4 including Neon at four levels) get exact receipts under an API key on both platforms, without `AGY_ACP_DEFAULT_MODEL` |
| Kill and resume | Native process killed between turns; a new process resumes the session | Passed prompt-free on macOS and Linux x64 with exact receipts. With completed prompts (2026-11-23, local, sign-in): native process kill recovered and the task finished. No live `session/load` call was observed in the logs |
| Launch cost | Run start to native initialize | Sealed verified store: 1.46 s (macOS) / 1.74 s (Linux x64), from 3.45 / 3.65 s. Measured before the launcher regained its streamed executable hash (below); that hash measured ~60 ms for the 179 MB macOS server and is not yet re-measured for the ~722 MB Linux launcher |
| Model lineup inference | Per model/level: one accepted prompt | Partial: `gemini-3.8-flash-low` (2026-11-23) and Gemini 4 Neon at four levels (2026-11-25, below) accepted prompts over Google sign-in (local). The rest of the lineup and the lineup suites are NOT RUN; the free API key still completes no prompt |
| Neon inference | Real task on `gemini-4-neon-*`, each level acknowledged | Passed locally (darwin-arm64, Google subscription sign-in, commit 438ae60922, 2026-11-25): one ordinary task per level, each Done in one run with requested = effective model and no usage limit. Low 65.9 s; medium 50.7 s (30,978 in / 4,406 out tokens); high 53.8 s (31,176 / 4,711); xhigh 68.9 s (46,152 / 5,499). API-key route and cloud sandbox NOT RUN |
| Ordinary task | File bytes, artifact, accepted result, Done after reload, local and Daytona | Local darwin-arm64 passed on 1.5.2 (sign-in, 2026-11-23), including a follow-up on the same task. Daytona NOT RUN |
| Scoped tools | Semantic and MCP round trip; wrong-company and stale authority denied | NOT RUN |
| Questions and permissions | Native identity, one continuation, denial holds | Question passed locally (asked, answered, task finished). Permissions NOT RUN |
| Stop and lifecycle | Stop during a tool call, pending-input Stop, provider death mid-turn, no late revival | Partial: Stop of a running task passed locally (run cancelled, task kept its status, as for every native harness). Pending-input Stop and provider death mid-turn NOT RUN |
| Continuity and recovery | Loaded session keeps model and instructions; interrupted run resumes or Retry works | Partial: prompt-free resume only (see Kill and resume) |
| Qualification suite | All 24 `antigravity-qualification` cells, local and Daytona | NOT RUN |
| Evals under the native Runner | Applicable Product E2E and chat cases run with Antigravity; numbers recorded | NOT RUN |
| Image pull and startup time | Daytona image with the Linux closure, measured cold | NOT RUN |
| Swarm (`/swarm`) | Native swarm starts from a task | Passed locally on the Antigravity CLI route behind the off-by-default flag (darwin-arm64, 2026-11-25): Gemini 3.8 Flash (Low) and Gemini 4 Neon (Low). See "/swarm live proof" below for what is and is not proven. Linux and cloud sandbox NOT RUN. The registry server 1.5.2 still has no swarm |

### First live tasks (2026-11-23, local, Google sign-in)

Setup: ACP server 1.5.2 (`1.5.2-paperclip.2`), darwin-arm64, a local source
checkout of Paperclip, Google sign-in connection, model
`gemini-3.8-flash-low`. A source checkout needed the dev-only "Run tasks in
this worktree" setting before tasks would start; installed builds do not.

| Case | Result |
| --- | --- |
| Ordinary task (create a file, reply with its content, mark Done) | Passed |
| Follow-up on the same task (recall the earlier file, append a line) | Passed |
| Question (agent asks, user answers, agent finishes) | Passed |
| Stop of a running task | Passed: run cancelled, task keeps its status |
| Native process killed during a task | Passed: recovered automatically and finished |

Provider capacity: 10 of 17 runs were refused by Google with 503
`No capacity available for model ...`; every task still finished through
automatic retries, with no user action. This exposed three product issues:

- Two refusals arrived after the agent's finish had already been accepted;
  the run was counted as failed and retried, so one task got the same reply
  three times. Fixed: an accepted done report followed only by a transient
  provider refusal (capacity or rate limit) is now the run's outcome, for
  every native harness.
- A refusal before any accepted result takes the saved-work replacement
  path (about 30 s, task shown as blocked meanwhile), while one after an
  accepted result takes the bounded capacity retry. Both carry the same typed
  `overloaded`/`transient` failure; the split is by path, not by classifier.
  Open decision below.
- Antigravity 1.5.2 streams the provider's error text as agent text before it
  ends the turn, so the live transcript shows it like a reply. Open below.

No live `session/load` call was observed in the logs, so the profile still
must not claim `recovery: "session-load"`.

### Must pass live before the qualification flip

1. All 24 `antigravity-qualification` cells, local (darwin-arm64) and Daytona
   (linux-x64).
2. The 14-cell API-key lineup, each with an accepted prompt.
3. The Gemini 4 lineup, including Neon at every level, on a paid key.
4. A live `session/load` observed before the profile claims
   `recovery: "session-load"`.
5. The attended Google sign-in journey on 1.5.2 (local only).
6. Daytona image pull and startup time, measured.

### Excluded or unsupported for this release

- Orchestrator model: excluded. 1.5.2 does not list it over ACP.
- `/swarm`: not available. The live 1.5.2 `available_commands_update` lists
  only `plan`, `logout` and `usage`, and the agent gets no swarm tools.
- Google sign-in in a cloud sandbox: refused at save and Test.
- Warm (session-reusing) runs: per-turn only.
- darwin-x64: no native host; inventory only.
- linux-arm64: verified statically; not started, so not claimed.

### Operator recipe (local, API key)

1. Install the runtime: `paperclipai runtime setup antigravity`. It downloads
   the pinned 1.5.2 archive, checks it against the registry checksum and
   installs the patched closure for this host (darwin-arm64 or linux-x64).
2. In Paperclip, add an AI connection for Google Antigravity and choose the
   Google API key method, paste a Gemini API key and use Test.
3. On the agent, pick Google Antigravity and choose a model family and thinking
   level. A free-tier key can be admitted but may be refused at prompt time;
   Neon needs a paid key.
4. Not supported: Google sign-in in a cloud sandbox, warm sessions,
   the Orchestrator model, `/swarm`, darwin-x64.

While the profile is pending, a cloud (Daytona) run needs an operator grant
for the company and exact model that names linux-x64 and the patched linux-x64
closure, with an API-key connection, per-turn. The runner E2E harness stages
that grant for Daytona cells; a local cell's grant names the host instead.
With that grant, the agent picker offers Google Antigravity for a Core sandbox
or SSH environment that is linux-x64 with a supported glibc (or the managed
cloud image), and for this host only a grant that names this host. It offers
nothing for a plugin Runner-task environment (the warm Agent Computer in
Paperclip Cloud): that path cannot launch Antigravity yet (see Open decisions).

### Launch integrity follow-up (2026-11-22)

The sealed verified store removed the per-launch closure copy, but its first
version trusted the store's recorded kernel identity for the executable. A
process running as the runner's user can rewrite both a stored file and that
record, so the launcher would have spawned a replaced executable. The launcher
again hashes the exact executable descriptor it spawns against the pinned digest
(streamed in 4 MiB chunks, so memory stays bounded), and the module guard still
hashes every Node module at load. The store also now holds the closure's module
guard beside its entrypoints, which Pi's pinned `pi-entry.cjs` hands to its
child; without it Pi launches from the store failed. The Kimi, Pi and Copilot
provider-death fixtures now target the store and per-launch directory layout.

### Integration round (2026-11-22, no live cells yet)

- Typed turn failures reach the user: a refused model is named with its fix
  (`antigravityModelRefusalMessage`), a 503 overload takes the bounded capacity
  retry, rate limits and quotas take the provider-limit wait, a rejected key is
  shown as the provider's plain message.
- Save and Test refuse Google sign-in in a cloud environment (route test).
- A refused saved-conversation reload is `provider_state_incompatible` on every
  reopen path; Antigravity never takes the Claude-only turn-end restart.
- Superseded sealed closure stores are retired once no live runner holds them.
- A verified provider pack is re-checked by kernel identity on the same sandbox
  (958 MB / 18,002 files: 4.3 s full re-hash, ~0.25 s on a reused lease in
  Daytona).
- CI builds the Daytona image and controller pack with the selected pending
  candidates; the qualification suite gained `permission-deny-stop` (24 cells).
- Live: the Gemini key still returns 429 `RESOURCE_EXHAUSTED` for
  `gemini-3.8-flash`, so no live cell ran.

## Open decisions

- Capacity refusals before an accepted result: route them to the bounded
  capacity retry (one-, then two-minute waits, then blocked) instead of the
  saved-work replacement, and keep the task out of "blocked" while that retry
  is pending. The replacement path proves the previous session stopped and
  reconciles unconfirmed actions before a fresh session; the capacity retry
  does not, so moving these failures changes a recovery safeguard.
- Hide provider error text that Antigravity streams as agent text when the
  turn then ends with a typed provider failure (runner driver change).

- A paid Gemini key for the prompt-dependent gates (the API-key route to Neon
  is admitted; inference is unproven).
- Orchestrator model: excluded for this release (not listed over ACP in 1.5.2).
- `/swarm`. Options:
  1. Keep it excluded (current state). A `/swarm` task runs as a plain
     request, and the agent may hire agents and make subtasks.
  2. Evaluate `agy acp` as the runtime. If it offers `/swarm`, swarm workers
     are sub-conversations inside one native process. Decide how their tool
     calls, approvals, usage and Stop map to one Paperclip run with one
     assignee and one budget.
  3. Map `/swarm` to Paperclip delegation: subtasks for existing agents, each
     with its own workspace, budget and approvals. Hiring needs a decision.
  Recommendation: option 1 now. Then evaluate option 2 with a paid key, and
  keep option 3 as the cross-agent pattern.
- Merge and production flip after the PR is green.
- Disposition of community PR #21121 (separate legacy-style adapter).
- Plugin Runner-task environments. Paperclip Cloud's warm Agent Computer runs
  agents only as plugin Runner tasks, and that path has no Antigravity launch:
  the plugin task credential contract has no Gemini API key type, the plugin
  prepares the provider launch without a candidate grant (so a pending profile
  is refused by the sidecar), the Cloud plugin's harness table lists only Codex,
  Claude and OpenCode, and Test refuses the path. Kimi, Copilot and Pi do not
  run there either. Closing it needs a plugin SDK contract change plus a Cloud
  plugin and image change.

## /swarm on the Antigravity CLI (2026-11-24)

What exists:

- **Trusted start.** The task composer reads a leading `/swarm` with the shared
  `parseLeadingUserCommand` rule and sends a structured `nativeCommand: "swarm"`
  with the request text. The server accepts it only from a signed-in user,
  records `issue.antigravity_swarm_requested` in the activity log and marks the
  assignee's wake. Pasted, quoted, agent or API text stays text and is still
  neutralised for the registry server.
- **Flag.** `instance.experimental.enableAntigravitySwarm` (Settings,
  Experimental, "Google Antigravity swarm"). Off by default. No Cloud policy in Core.
- **Refusals, in plain language, before anything runs:** flag off, not an
  Antigravity assignee, a chat, Plan mode, a remote or cloud environment, a
  Gemini API key (no auto mode), an unpinned platform, extra tool servers.
- **Driver.** `antigravity-swarm-*.ts` in the Runner. In place of the registry
  patch receipt it verifies identity and version, the instruction channel, the
  task folder as `cwd`, Paperclip's bridge as the only MCP server, `auto` mode
  and the exact model by read-back, and fails closed on any later change. One
  fresh session per run; at most one swarm per run; Paperclip delegation tools
  are removed from the bridge for the swarm turn.
- **Governance.** Helpers act in Antigravity's `auto` mode. The driver stops
  the swarm on any visible change outside the task folder (file tools and shell
  write targets, with `..`, `~`, `$HOME` and symlinks resolved), refuses every
  permission prompt except Paperclip's own tools, and shows what changed in the
  task folder. It does not settle on the first `end_turn` while helpers may run.
- **Not confined by Paperclip.** Helper tool calls never reach the client, and
  Paperclip's local process sandbox (`adapter-utils/local-process-sandbox.ts`,
  used only by the classic Claude and Codex local adapters) does not wrap Runner
  harnesses on macOS or Linux. Helper shell commands can therefore write outside
  the task folder wherever the CLI's own sandbox allows (workspace plus temp
  directories). The outside-path check is a detector for the coordinator's
  visible calls, not a boundary. The feature stays off by default.
- **Credentials.** On macOS the CLI uses its own Google sign-in from the login
  keychain (the real HOME), not Paperclip's stored Google connection. CLI state
  lives in a private `--gemini-dir`. Terms: a legal read of the consumer terms'
  third-party-tool clause is pending.
- **Usage.** One total from the coordinator, labelled as including the helpers.

<a id="swarm-live-proof"></a>
### /swarm live proof (local, attended)

Setup: a local instance from the swarm branch, a Google sign-in connection, an
Antigravity agent on `gemini-3.8-flash-low`, `paperclipai runtime setup
antigravity-cli` run as the Paperclip user, the Antigravity CLI signed in on
this computer, and the experimental flag on. Then, on a task for that agent:

1. `/swarm two helpers: one writes a.txt containing A, one writes b.txt
   containing B; a verifier checks both`: native swarm, both files in the task
   folder, task Done, activity log names the swarm.
2. The same, then Stop mid-swarm: run cancelled, no `agy` process left.
3. The same, then kill the `agy` process mid-swarm: Paperclip recovers on its
   own with a fresh swarm in the same folder (at most three attempts per
   request); nothing posted twice. Retry starts one when recovery has stopped.
4. An ordinary follow-up comment after a swarm: runs normally (fresh session).
5. Flag off, `/swarm ...`: the composer shows "Swarm is not turned on ..." and
   nothing is posted or run.

| Gate | Result |
| --- | --- |
| Unit and fake-CLI tests (driver, guard, paths, route, server, composer) | Passed |
| 1. Swarm, Gemini 3.8 Flash (Low), Antigravity CLI 1.5.15, Google's default channel | Passed: a real swarm (two helpers and a verifier) Done in 49.5 s, files correct, nothing posted twice |
| 1. Swarm, Gemini 4 Neon (Low) | Passed: Done in 115 s (92,378 in / 6,733 out tokens), requested = effective model |
| 2. Stop with 7 helpers active (Flash) | Passed: every CLI and helper process gone in 0.7 s, no re-run. Gap: the stopped run recorded no usage (fixed in this pull request) |
| 3. Kill the CLI process mid-swarm (Flash) | Passed: recovered automatically with a fresh swarm, Done. Gaps: no usage recorded for the killed run, and the failure text asked for Retry while recovery continued on its own (both fixed in this pull request) |
| 4. Ordinary follow-up after a swarm | Passed: 41 s (Flash), 105 s (Neon). A completed swarm was not run again (checked 10 minutes later) |
| Refusals with the flag on | Passed: an empty request, Plan mode and Ask mode answer 422 in plain words and post nothing; a quoted `/swarm` runs as ordinary text |
| Thread text | Gaps found and fixed in this pull request: the CLI's terminal hint ("Run /swarm board …") and a stray "." reached the thread; replies linked task-folder files by absolute local `file://` path (also on ordinary Antigravity runs); the coordinator named Paperclip's swarm rules. The settings receipt now reaches the run record as a provider notice |
| 5. Flag off | NOT RUN live (unit tests only) |

Not proven live: Stop or kill on a Neon swarm; pressing Retry on a swarm
(recovery never needed it); typing `/swarm` in the browser composer (the live
runs used the comments API with the composer's structured request); the Linux
and cloud sandbox routes; the paid qualification cells and lineup suites. The
profile stays **pending** until an operator grants the flip.

Facts above: local darwin-arm64 instance at commit 438ae60922, 2026-11-25,
Google subscription sign-in.

### Re-check of the swarm fixes (local, 2026-11-25, commit cd8bcfba16)

| Gate | Result |
| --- | --- |
| Usage on Stop (Flash) | Passed live: the stopped run recorded 36,910 in / 869 out tokens |
| Usage on a killed CLI | Still 0 live: CLI 1.5.15 streams no token counts during a swarm prompt and reports them only when the turn ends, so a killed run has nothing to keep. Documented; not estimated |
| Kill text and automatic recovery | Passed live: the failure says the CLI exited and files stay in the task folder, with no Retry; Paperclip recovered with a fresh swarm and the task finished |
| Settings receipt in the run record | Passed live: one provider notice with requested and confirmed model, thinking level, mode, channel, CLI version and account match |
| Thread text | Passed live: no terminal hint, no stray ".", no local paths or `file://` links, no mention of the swarm rules |
| Helper processes after a killed CLI | Gap found live: helper shell commands lead their own process groups, outlived the killed CLI by about 14 s, one wrote a file 14 s after the kill, and the failure was recorded only when they exited (they held the CLI's output pipe). Fixed in a later pull request: the swarm records every process the CLI starts and stops them all before a failed or stopped turn is reported and on shutdown, and a lost CLI is detected on exit. Proven with the fake CLI (kill, Stop, shutdown; an unrelated process survives); live proof pending |
