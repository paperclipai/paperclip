# Google Antigravity in Paperclip Cloud: rollout plan — 2026-11-25

Continues the [qualification ledger](2026-11-22-antigravity-qualification.md).
That ledger stays the record of what is proven. This document says what Cloud
needs before Antigravity can be offered there, and splits the work into
pull requests that implementers can pick up.

Owner decisions (2026-11-25):

- Enable Google Antigravity everywhere, starting with paperclip.staging.
- Cloud sandboxes support **both** a person's Google subscription sign-in
  (the stored Google connection) **and** Gemini API keys.
- `/swarm` stays local-only. Read confinement is out of scope.
- Core holds no Cloud policy (AGENTS.md section 5,
  [harness availability](../harness-availability.md)). Cloud's harness list is
  a fleet `env_config` campaign on `PAPERCLIP_AVAILABLE_HARNESSES`; the
  canonical ID is `antigravity_runtime`.
- Waive `runner-e2e-paid` (item 7) as a blocker for the item 8 qualification
  flip (`pending` to `qualified`, profile revision `2`, `recovery: "unverified"`)
  so Antigravity can ship to `paperclip.staging` and be tested there. Paid-key
  qualification rows stay marked NOT RUN in the qualification ledger until
  actually executed.

Evidence below was read on 2026-11-25 from Core `master` at `87083fe982` and
paperclip-cloud `master` at `f3b9e76`. Between `87083fe982` and this PR's base,
none of the exact Core files cited here changed (one commit touched five
unrelated test, UI and story files), so the Core line numbers hold at the base. "Core" paths are in this repository.
"Cloud" paths are in the private paperclip-cloud repository. Nothing here was
observed in a live staging run; rows that need a live check say so.

## Finish line

Copied from the kickoff success criteria. Re-read before saying "done".

1. On paperclip.staging, a user creates an agent with Google Antigravity in the
   normal picker (no operator grant), binds a Google connection by
   subscription sign-in **or** API key, picks a model (Flash and Neon levels),
   assigns ordinary work, and the run completes Done in the Cloud sandbox (the
   environment kind staging actually uses: Agent Computer or managed sandbox;
   item 12 establishes which first), with usage recorded and a plain-language
   thread.
2. Recovery holds in Cloud: Stop works; a mid-run deploy or restart resumes,
   or Retry works (0% needed-retry target).
3. The profile is qualified (pending to qualified, profile revision `2`,
   `recovery: "unverified"`) under the owner's 2026-11-25 waiver of
   `runner-e2e-paid` so staging testing can proceed; the paid-key rows stay
   marked NOT RUN in the ledger until run.
4. Cloud policy lists `antigravity_runtime` through a fleet `env_config`
   campaign: staging first and verified, production after.
5. Credentials: a person's Google token placed in a sandbox is scoped to that
   connection and agent, never logged, never visible to other tasks, and
   disconnect deletes Paperclip's saved copy (no revoke at Google, see G10).
6. Every PR: green checks, Greptile 5/5, merged; deploys watched; staging
   verified.
7. The ledger records what is and is not proven.

Not in scope: `/swarm` in Cloud; read confinement.

## 1. How an agent run executes in Cloud today

### Two environment kinds, one Runner

Cloud gives each stack two kinds of managed environment
(Cloud `src/fleet/materializer.ts:148-176`, `:296-312`):

| Environment | Core driver | How the run starts |
| --- | --- | --- |
| "Paperclip Computer" (`tasks`), "Paperclip Sandbox (Daytona)" (`daytona-tasks`), "Paperclip Sandbox (Unikraft)" (`unikraft-tasks`, experimental) | `plugin` (the Agent Computer plugin) | Core's native session executor sends a **plugin Runner task**. The plugin's Launcher starts `paperclip-runnerd` and the provider driver on the computer or sandbox. |
| Platform-managed sandbox from fleet environment defaults (also named "Paperclip Sandbox") | `sandbox` (Core's sandbox driver with a provider plugin) | Core's own remote sandbox path. Core ships the Runner and provider pack from its image. |

All three plugin drivers declare `supportsTasks: true`
(Cloud `extensions/plugin-agent-computer/src/manifest.ts:26-48`). Core turns
that declaration into a Runner target with `runnerTasks: true`
(Core `server/src/services/agent-runner-selection.ts:420-424`,
`server/src/services/plugin-runner-ai-connection.ts:27-40`).

New stacks get the Paperclip Computer as the instance default only when the
fleet environment defaults set `paperclipComputerDefault`; otherwise and on
existing stacks the managed sandbox stays the default (Cloud
`docs/cloud-harness-app-paperclip-cloud-runbook.md:4269-4277`). Which one
staging's stacks use today was not read live (it needs fleet admin). The plan
covers both.

### (A) Claude, Codex, Grok and OpenCode run on the native Runner

On a plugin Runner-task target, Core offers **only** the Paperclip Runner, never
the older local adapters (Core `server/src/services/agent-runner-selection.ts:68-71`:
`supportedRunners: target.runnerTasks ? ["paperclip"] : ...`). So
`claude_local`, `codex_local`, `grok_local` and `opencode_local` agents in a
plugin environment run as native Runner sessions. On the Core sandbox
path with the managed image, the Runner is the default and legacy stays
selectable (same lines).

Per harness on the Agent Computer (Cloud
`extensions/plugin-agent-computer/src/harnesses.ts:38-46`, mirrored by the
Launcher table Cloud `agent-computer/harness/harnesses.json`):

| Harness | Runner driver | Credential delivered as | Retained (warm) |
| --- | --- | --- | --- |
| Codex | Codex app-server | `codex-auth-json` file slot `.codex/auth.json`, with write-back | native |
| Claude | ACPX sidecar (`claude`) | `claude-env` (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) | acpx |
| Grok | ACPX sidecar (`grok`) | `provider-env` `XAI_API_KEY` | per-turn |
| GitHub Copilot | ACPX sidecar (`copilot`) | `provider-env` `COPILOT_GITHUB_TOKEN` | per-turn |
| OpenCode | OpenCode server | `provider-env` `OPENROUTER_API_KEY` or the Paperclip provider pair | per-turn |

Core builds the task credential in
`server/src/services/native-runtime/plugin-runner-credentials.ts:19-68`, called
from `server/src/services/native-runtime/native-session-executor.ts:16992-16996`.
Any other provider throws "Plugin Runner does not support the selected
credential provider" (`plugin-runner-credentials.ts:67`).

### (B) The Copilot question: the ledger is out of date

Copilot runs on the Agent Computer through the ACPX sidecar. The ledger's
"Kimi, Copilot and Pi do not run there" line predates these merges:

- Core #22359 (2026-11-20) added the generic `provider-env` task credential for
  Grok, Copilot and OpenCode
  (`packages/plugins/sdk/src/environment-tasks.ts:59-75`,
  `plugin-runner-credentials.ts:54-66`).
- Cloud #1696 (2026-11-23) added the `copilot` row to both harness tables, the
  Copilot closure to the Runner ROM (Cloud `agent-computer/runtime/select-pack.mjs:12-18`),
  and Launcher credential checks.
- The Runner ROM's pinned Core source (Cloud
  `agent-computer/runner-source.lock.json`) contains #22359. Cloud `master`
  was deployed to staging on 2026-11-25.
- Copilot needs no operator grant: its ACPX profile is qualified, and Core
  admits it from the release declaration alone
  (`server/src/services/native-runtime/acpx-qualification.ts:86-95`).

So the code says a Copilot agent on staging runs; it is not "offered but
unable to run". A live Copilot run on staging was not observed for this plan
(see work item 0). Kimi, Pi and Cursor still have no row in the Cloud tables.

**Copilot is the template for the Antigravity API-key route:** a qualified
ACPX profile, a `provider-env` credential type, one row in each Cloud harness
table, the closure in the Runner ROM, and the harness ID in the fleet list.
Codex is the template for the sign-in route, because only Codex carries a
refreshable file credential with write-back to the plugin path today.

## 2. What Antigravity is missing on that path

| # | Gap | Evidence | Belongs to |
| --- | --- | --- | --- |
| G1 | The profile is `pending`. A pending profile needs a per-run operator grant, and the plugin launch contract has no field for it: the launch requirements settings are a strict object with no candidate grant (`packages/plugins/sdk/src/environment-tasks.ts:86-104`, `packages/paperclip-runner/src/live/runner-provider-launch.ts:29`). The Core sandbox path passes the grant in transport options instead (`native-session-executor.ts:18987-18991`). | as cited | Core (flip) |
| G2 | No image carries the closure. The Core image builds the provider pack without candidates (`Dockerfile:258`), and the pack adds Antigravity only when released (`packages/paperclip-runner/scripts/candidate-provider-pack.mjs:28-37`). The Cloud fleet sandbox image copies that pack (Cloud `fleet-sandbox-image/Dockerfile:141`). The Agent Computer ROM builds the pack the same way (Cloud `agent-computer/Dockerfile.runner:92`) and copies only Copilot's provider assets (Cloud `agent-computer/runtime/select-pack.mjs:14-18`). | as cited | Core (flip) and Cloud (ROM select list) |
| G3 | No task credential for Google. `provider-env` allows only `grok`, `copilot`, `opencode` (`environment-tasks.ts:59-67`); `preparePluginRunnerCredentials` has no Antigravity branch (`plugin-runner-credentials.ts:54-67`). The Runner itself already takes either `GEMINI_API_KEY` or the sign-in JSON in `PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET` (`packages/paperclip-runner/src/drivers/acpx/antigravity-credentials.ts:7`). | as cited | Core plugin SDK contract |
| G4 | Sign-in write-back only exists for Codex on the plugin path (`native-session-executor.ts:17018`, `syncPluginTaskCredentialHandoff`). The Runner writes a rotated Google refresh token to `auth-refresh.json` (`antigravity-credentials.ts:35-80`), and Core expects to apply it (`server/src/services/native-runtime/antigravity-runner-credentials.ts:97-115`). | as cited | Core SDK contract and Cloud plugin |
| G5 | No Cloud harness row. Unknown harnesses fail as "Unsupported task provider" (Cloud `extensions/plugin-agent-computer/src/tasks.ts:675`, `:823`). | as cited | Cloud plugin and Launcher |
| G6 | Core refuses the path on purpose: the picker offers no candidate for a Runner-task target (`server/src/services/native-runtime/antigravity-release.ts:24-33`), and Test answers "unavailable in this hosting environment" (`server/src/services/antigravity-connection-probe.ts:60-61`). | as cited | Core |
| G7 | Remote sign-in is refused at save, Test and run start (`server/src/services/native-runtime/antigravity-connection-policy.ts:42-45`, `server/src/routes/agents.ts:3292-3302`, `antigravity-runner-credentials.ts:73-74`). | as cited | Core |
| G8 | Warm default conflicts with per-turn only. A plugin environment's `runnerLifecycleMode` wins over the agent's setting (`server/src/services/runner-environment-lifecycle.ts:14-23`, `:92-93`), and the managed Daytona and Unikraft task environments set `warm` (Cloud `src/fleet/materializer.ts:163`, `:175`). Antigravity refuses warm at run start (`antigravity-connection-policy.ts:29-31`), but the save-time check does not pass the lifecycle (`agents.ts:3299`). So an Antigravity agent on those environments would save, then fail every run. | as cited | Core |
| G9 | A Cloud user cannot create a Google sign-in. Hosted instances refuse server-host sign-in (`server/src/services/local-ai-login-policy.ts:4-12`, `server/src/routes/ai-connections.ts:153`). Google sign-in is a PKCE flow whose redirect is `http://127.0.0.1:<port>/` on the server (`packages/paperclip-runner/src/drivers/acpx/antigravity-auth.ts:47-60`), which a remote browser cannot reach. Cloud's other sign-ins use a login terminal on the computer, and only Codex can read a credential back from it (`packages/plugins/sdk/src/protocol.ts:1120`, `:1167-1180`; `server/src/services/plugin-login-credential.ts:13-23`). | as cited | Core (route, UI) |
| G10 | Disconnect left the saved sign-in in Paperclip. Decision: Paperclip deletes its saved sign-in on disconnect and removal and does not revoke at Google. The sign-in uses the OAuth client of Google's own Antigravity runtime (`antigravity-auth.ts:12`), and Google revocation "removes all OAuth 2.0 scopes previously granted to a project" (Google OAuth native-app guide, "Token revocation"). A revoke would sign the person out of their own Antigravity app or CLI and out of every other connection for that Google account. | as cited | Core |

Closest templates:

- API key on the Agent Computer: **Copilot** (Core #22359 plus Cloud #1696,
  26 files in Cloud).
- Sign-in on the Agent Computer: **Codex** (file credential plus write-back
  through the task `credentials` snapshot).
- Login creation: no existing template works on a hosted instance; see 3.

Grok is a warning, not a template: on the plugin path it refuses subscription
sign-in outright (`plugin-runner-credentials.ts:58`).

## 3. Google subscription sign-in in a sandbox

### How the Google connection stores and refreshes the credential today

- The connection's capability is `google.subscription`, env key `GEMINI_HOME`
  (`packages/shared/src/ai-connections.ts:99-102`).
- The credential is a company secret referenced by the connection grant
  (`ai.credential`). Each run reads it with an epoch check, so a concurrent
  reconnect or rotation fails the read instead of mixing versions
  (`server/src/services/ai-connection-runtime.ts:280-308`).
- For each run Core writes a private, disposable home (`mkdtemp`, mode 0700),
  with `antigravity-acp/settings.json` (`auth.type: oauth-personal`) and
  `antigravity-acp/acp_token.json` (mode 0600)
  (`ai-connection-runtime.ts:309-376`). The stored JSON holds only the fixed
  client ID, token URI, client secret, refresh token, the required `scopes`
  list and `project_id` when present (`antigravity-auth.ts:31-45`).
- The Runner receives the sanitized JSON as
  `PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET`, never a path
  (`antigravity-runner-credentials.ts:76-94`), and stages it into its own
  isolated home.
- A rotated refresh token comes back in `auth-refresh.json`. Core accepts it
  only after it proves the same Google account, then saves it with the
  generation-checked write-back (`antigravity-runner-credentials.ts:97-115`,
  `ai-connection-runtime.ts:420-520`).
- Access tokens are short-lived and derived from the refresh token per run;
  only the refresh token is durable.

### How OpenAI and Anthropic subscriptions reach Cloud sandboxes today

- **Codex (ChatGPT sign-in):** Core reads the selected account's `auth.json`
  and sends it as a `codex-auth-json` task credential
  (`plugin-runner-credentials.ts:32-45`). The Launcher installs it in the
  account profile's file slot `.codex/auth.json` (Cloud
  `agent-computer/harness/harnesses.json`, `codex` row). Refreshed tokens come
  back through the task `credentials` snapshot and
  `syncPluginTaskCredentialHandoff` (`native-session-executor.ts:17018-17024`).
- **Claude (subscription):** Core sends `CLAUDE_CODE_OAUTH_TOKEN` as a
  `claude-env` task credential (`plugin-runner-credentials.ts:46-53`). The
  Launcher puts it in the task's private environment only
  (Cloud `agent-computer/launcher/task_credentials.go:18-63`).
- **Creation:** on the computer's login terminal (`codex login --device-auth`,
  `claude setup-token`), Cloud `agent-computer/harness/harnesses.json` `login`
  fields. Codex's result is read back through `loginPtyReadCredential`; Claude's
  setup token is pasted by the user (`server/src/services/setup-token-ai-connection.ts`).

### What the sandbox needs for Google sign-in

Reuse the Claude delivery for the token and the Codex path for write-back:

1. **Token material:** exactly the output of `sanitizeAntigravityCredential`
   (`antigravity-auth.ts:31-45`): client ID, client secret, refresh token,
   token URI, the required `scopes` list, and `project_id` when present.
   Delivery must carry that output unchanged; dropping `scopes` makes the
   Runner reject the credential. Never an access token cache, never the
   account email (the Runner gets only a digest).
2. **Delivery:** a typed task credential that the Launcher puts in the task's
   private environment, as `PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET`. What
   exists: the Runner writes it to `<agentHomeDirectory>/antigravity-acp/acp_token.json`
   (directory 0700, file 0600, owner-checked;
   `packages/paperclip-runner/src/drivers/acpx/antigravity-credentials.ts:22-40`)
   and removes it when the lease closes (`antigravity-credentials.ts:51-90`).
   `agentHomeDirectory` sits under the Runner's runtime root
   (`packages/paperclip-runner/src/drivers/acpx/runtime-sandbox.ts:406-421`).
   What is missing: on the Agent Computer that root must be task-private, not
   shared by the agent's other tasks (see the isolation row below; owned and
   tested by item 9).
3. **Refresh:** the Runner refreshes access tokens itself. A rotated refresh
   token returns through a `credentials` snapshot (as Codex), and Core applies
   it with the existing identity check and epoch guard.
4. **Creation in Cloud:** a hosted sign-in that the user completes in their own
   browser. Recommended: Core starts the PKCE flow on the server and keeps the
   verifier; Google redirects the browser to the loopback address, which fails
   on the user's machine; the user pastes that address (or its `code`) into
   Paperclip; Core checks `state`, exchanges the code, verifies the account,
   and saves the connection. The existing `.../local/attempts/:sessionId/code`
   route already carries a pasted code for local sign-in
   (`server/src/routes/ai-connections.ts:213-222`); the hosted route must not
   need the local-login exemption. The pasted value is a bearer credential
   until exchanged, so: it travels only in a POST body (never a query string),
   it is never written to access, activity, error or analytics logs, it is
   single-use, it is bound to the user and attempt that started the flow, and
   it expires with the server-side attempt. **Spike first:** confirm Google issues a
   refresh token for this client on a loopback redirect that Paperclip's
   listener did not receive, and that the flow works in Google's consent
   screen for consumer accounts. If it does not, the fallback is the Agent
   Computer desktop browser (Cloud `extensions/plugin-agent-computer/src/desktop.ts`),
   which is heavier and computer-only.

### Security requirements and where each is met

| Requirement | Mechanism |
| --- | --- |
| Token never logged | The credential only travels in typed task credentials and private task environment. The Launcher must reject `PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET` (exact name) and the `GEMINI_` and `GOOGLE_` prefixes in any configured or project environment, as it does for Copilot's `COPILOT_` prefix. Add a test that searches the run log and Launcher logs for the token after a run. |
| Scoped to the run | One task credential per task, bound to the account binding and session (Cloud `task_credentials.go:64-70` `credentialBinding`); per-turn only. |
| Not readable by other tasks | Today's mechanism: each agent has its own computer or sandbox (the task drivers declare `requiresAgent: true`, Cloud `extensions/plugin-agent-computer/src/manifest.ts:26-48`), so other agents' tasks never share it. Inside one computer, every task of that agent runs as the **same** UID/GID 1000 on a shared kernel; each task gets its own private mount namespace and user namespace, and `/home/agent` is shared (Cloud `agent-computer/launcher/README.md`, "Namespace isolation" and the task entry row). Same-UID tasks are therefore not a boundary by themselves. The implementation must add: the credential home under the task's private path (`/run/paperclip-runner-tasks/<task-id>`), never `/home/agent` or a profile slot; removal when the task ends; and proof that a concurrent task of the same agent cannot read it, neither the file nor `/proc/<pid>/environ` or memory of the Runner process. If that proof fails, pass the token through a file in the private task mount instead of the environment, or run Antigravity tasks one at a time per computer. Keep the cross-task read test as a regression test. Owner: item 9 alone (the Launcher gives the Runner a runtime root under the private task path, so `agentHomeDirectory` is task-private, and item 9's acceptance carries the cross-task read test). |
| Deleted on disconnect | On disconnect or removal, delete the saved sign-in and record an activity entry. Do not call Google's revoke: the client is Google's own Antigravity client, so a revoke would also sign the person out of their Antigravity app or CLI and every other connection for that account. The person removes access in their Google account if they want it ended at Google. Running tasks keep their current turn. |

## 4. The qualification flip

Original rule (ledger "Acceptance ledger"): the profile stayed pending until
every NOT RUN row passed live. **Owner waiver (2026-11-25):** the owner waived
`runner-e2e-paid` as a flip blocker so item 8 can flip the profile to
`qualified` (profile revision `2`, keeping `recovery: "unverified"`) and ship
to `paperclip.staging` for live testing there. Every NOT RUN row below remains
NOT RUN (deferred, never marked passed).

| NOT RUN row | Needs a paid Gemini key? | Can the sign-in route satisfy it? |
| --- | --- | --- |
| Qualification suite, 24 cells, local (darwin-arm64) and Daytona (linux-x64) | Yes: the suite uses `GEMINI_API_KEY` (`.github/workflows/runner-full-stack-e2e.yml:1480`); the free key returns 429 or 503 | Not as written: the suite is unattended and API-key only (`tests/runner-e2e/SUITES.md:1664-1726`). The lifecycle cells could be re-pointed at a sign-in connection only by an owner decision to change the rule. |
| 14-cell API-key lineup, each with an accepted prompt | Yes | No (it qualifies the API-key route) |
| Gemini 4 lineup including Neon at every level, on a paid key | Yes | Partly done already on sign-in (local, four Neon levels Done) |
| Live `session/load` before claiming `recovery: "session-load"` | No | Yes. Or keep recovery `unverified` and flip without the claim. |
| Attended Google sign-in journey on 1.5.2 (local) | No | Yes (attended) |
| Daytona image pull and startup time, measured | No (any key) | Yes |
| Ordinary task on Daytona | No (any working credential) | Only after G7 is lifted |
| Scoped tools; permissions; pending-input Stop; provider death mid-turn | Yes inside the suite | Yes, if run attended |
| Evals under the native Runner | Yes for unattended CI | Yes, if attended |

Where they run: `runner-full-stack-e2e.yml` (`workflow_dispatch`, suite
`antigravity-qualification`, environments `local` and `daytona`), jobs in the
`runner-e2e-paid` environment (`.github/workflows/runner-full-stack-e2e.yml:1054-1055`).
Paid runs use repository secrets, so they may only run CODEOWNER code from
`master` (the workflow runs from `master` and tests a named branch) and need
gate approval. The Daytona cells use Core's sandbox path, not the Agent
Computer, so they do not prove finish line 1; work item 12 does that on staging.

## 5. Other blockers for "enable everywhere"

- **Image and ROM size, cold start.** The verified pack is about 958 MB and
  18,002 files; the Linux launcher alone is about 722 MB (ledger "Integration
  round" and "Launch cost"). The Agent Computer ROM and the fleet sandbox image
  both grow by that much. Measure ROM build time, pull time, computer boot and
  time to first token, cold and warm, before and after. The ledger's per-launch
  executable hash has not been re-measured for the 722 MB launcher.
- **glibc.** The Runner floor is glibc 2.39
  (`packages/shared/src/agent-runner.ts:32-44`). The Agent Computer OS and the
  Daytona task image use Debian trixie (glibc 2.41; Cloud
  `agent-computer/os/Dockerfile:2`, `agent-computer/Dockerfile.daytona:2`).
  The fleet sandbox base is `daytonaio/sandbox:0.8.0`; its glibc was not
  checked. Check it with one native initialize on each image.
- **Model catalog.** API-key catalogs are static
  (`server/src/services/antigravity-connection-models.ts:10-29`). Sign-in
  catalogs start the native server **on the tenant host** with the
  connection's home (`antigravity-connection-models.ts:30-46`). On Cloud the
  tenant image must carry the closure (true after the flip, from
  `Dockerfile:258`) and the tenant (trixie, `Dockerfile:2`) must run it. Check
  memory on small tenants while a catalog read runs.
- **Front door.** The new hosted sign-in route is under the authenticated
  `/api/companies/:companyId/...` tree, so Cloud's anonymous allowlist does not
  change. If the design adds any anonymous callback route, that is a Cloud
  security-policy change.
- **Usage and analytics.** Runner usage is per run, as for other ACPX
  harnesses. Check that usage rows and the Cloud PostHog funnel accept the new
  harness ID; Cloud product analytics has no per-harness allowlist
  (Cloud `docs/product-analytics.md`).
- **Google terms.** The legal read of the consumer terms' third-party-tool
  clause is still pending. The owner chose to enable sign-in in Cloud anyway.
- **Provider capacity.** Google refused 10 of 17 local runs with 503 on
  2026-11-23. The open decision on capacity refusals before an accepted
  result (ledger "Open decisions") affects the needed-retry rate in Cloud.
- **Fleet rollout mechanics.** The campaign must carry the **whole** array
  (Cloud `docs/harness-availability.md`, "Change the policy"); the bootstrap
  fallback is Cloud `src/fleet/cloud-harness-availability.ts:9-15`.

## 6. Work breakdown

Every PR: red/green tests, the PR template, green checks, Greptile 5/5, merge,
watch the deploy. Cloud PRs follow Cloud's own rules; implementers there work
in that repository.

| # | Title | Repo | Files | Acceptance | Depends on | Parallel group |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Prove Copilot runs on the staging Agent Computer | none (verification) | none | One Copilot agent on a staging Paperclip Computer completes a task; record the run's environment driver and duration. Confirms the template. | none | A |
| 1 | Add Antigravity API-key task credential for plugin Runners | Core | `packages/plugins/sdk/src/environment-tasks.ts`, `server/src/services/native-runtime/plugin-runner-credentials.ts`, tests | `provider-env` accepts provider `antigravity` with key set `[["GEMINI_API_KEY"]]`; mixed or partial sets are rejected; the Runner's Antigravity credential preparation still strips `GOOGLE_*` keys | none | A |
| 2 | Add Antigravity sign-in task credential with refresh write-back | Core | same files plus `native-session-executor.ts` (write-back sync beside Codex), `antigravity-runner-credentials.ts` | New credential carries only the sanitized sign-in JSON as `PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET`; a rotated refresh token from a task snapshot is saved only after the account check; a different account is refused; a test proves no token in logs | 1 | B |
| 3 | Keep per-turn-only harnesses per-turn on warm plugin environments | Core | `server/src/services/runner-environment-lifecycle.ts`, `server/src/routes/agents.ts` (save check), tests | An Antigravity agent on a plugin environment with `runnerLifecycleMode: "warm"` runs per-turn, or save refuses it in plain words; no run fails with the warm refusal | none | A |
| 4 | Hosted Google sign-in (spike, then route and UI) | Core | `server/src/routes/ai-connections.ts`, `server/src/services/local-ai-login.ts`, `local-ai-browser-login.ts`, Runner `antigravity-auth.ts`, UI connection dialog | Spike answers the loopback question first. Then: on an authenticated public instance, a user completes Google sign-in by pasting the redirect; wrong `state`, reused code and another user's attempt are refused; the connection lists models | none | A |
| 5 | Delete the saved Google sign-in on disconnect (no revoke at Google, see G10) | Core | AI connection removal and grant revocation paths, activity log | Disconnect deletes the saved sign-in (a shared one is kept; a failed delete keeps a retryable reference), the activity entry says in plain words that the sign-in stays valid at Google until the person removes it there, a later run asks to reconnect | none | A |
| 6 | Allow Antigravity on plugin Runner-task and remote sign-in targets | Core | `antigravity-release.ts`, `antigravity-connection-probe.ts` (use the plugin probe path, `server/src/services/native-runtime/plugin-runner-probe.ts`), `antigravity-connection-policy.ts`, `antigravity-runner-credentials.ts`, `agents.ts` | Tested against a released-profile fixture (the real profile is still pending when this merges): picker offers Antigravity on a plugin environment; Test runs the plugin probe; save and run accept sign-in on remote targets when 2 is present. The Core sandbox path gets the same sign-in support. Re-verified live in item 12. **Status: done.** Merged in #22940; run-start tests (pending profile refused on plugin and sandbox targets without a grant, released profile hands the plugin Runner its typed API-key or sign-in credential) added in a follow-up | 1, 2, 3 | C |
| 7 | Qualification runs on a paid key (waived as item 8 blocker on 2026-11-25; deferred) | Core (ledger) | `doc/plans/2026-11-22-antigravity-qualification.md` | All NOT RUN rows in section 4 pass live (24 cells local and Daytona, both lineups, session-load or no claim, attended sign-in journey, image pull time) | paid key (owner) | A (deferred) |
| 8 | Flip Antigravity from pending to qualified | Core | `packages/paperclip-runner` release declaration and generated profiles (profile v2), capability profile (`recovery: "unverified"`), adapter-utils, server routes/profile/qualification, docs | Owner waiver recorded honestly in ledger; the Core image's `linux-x64` provider pack includes the closure without a candidate flag; no operator grant needed | 3 (7 waived on 2026-11-25) | D |
| 9 | Run Antigravity on agent computers through ACPX | Cloud | `extensions/plugin-agent-computer/src/harnesses.ts`, `agent-computer/harness/harnesses.json`, `harness.go`, Launcher `task_credentials.go`, `configured_environment.go`, `agent-computer/runtime/select-pack.mjs`, `assemble.mjs`, `pack-manifest.mjs`, `verify*.mjs`, tests (copy Cloud #1696) | Row `antigravity`: driver `acpx`, `acpxAgent: "antigravity"`, `projectAuthProvider: "google"`, credential `task-env` with key sets `GEMINI_API_KEY` or the sign-in key, reserved prefixes `GEMINI_` and `GOOGLE_`, reserved exact key `PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET` with a negative test (a configured or project environment that sets it is refused), blocked project settings for `.gemini/settings.json` endpoint and key fields, the Runner's runtime root (so `agentHomeDirectory`) in the private task path, with a test that a concurrent task of the same agent cannot read the staged file, `/proc/<pid>/environ` or Runner memory, per-turn, closure under `provider-assets/antigravity/linux-x64` copied into the ROM. Tests pin the two tables together | 1, 2 (types); ROM content needs 8 | B (code), E (ROM) |
| 10 | Pin the Runner ROM to a Core with the flip | Cloud | `agent-computer/runner-source.lock.json`, `runner-pnpm-lock.yaml` | ROM and fleet sandbox image build; closure verified at build; ROM size, build time, boot and first-token time recorded before and after | 8, 9 | E |
| 11 | Staging policy campaign | Fleet (operator action, no code) | `env_config` campaign with the full array plus `antigravity_runtime`, canary first | Staging `/api/health` lists the exact array; picker shows Google Antigravity | 10 deployed on staging, 6 deployed | F |
| 12 | Staging acceptance (staging is the canary) | none (verification, ledger update) | ledger | First establish which environment kind staging stacks use (fleet environment defaults, `paperclipComputerDefault`). Then finish line 1, 2 and 5 on staging before any production exposure, both credential routes, Flash and Neon, Paperclip Computer and the managed sandbox; Stop; a restart mid-run resumes; disconnect deletes the saved sign-in | 11, 4, 5 | F |
| 13 | Update the Cloud bootstrap default | Cloud | `src/fleet/cloud-harness-availability.ts`, `docs/harness-availability.md` | New stacks born before fleet policy get the same list | 12 | G |
| 14 | Production campaign | Fleet (operator action) | as 11, production | Production `/api/health` lists the array; one production run Done | 12, owner go-ahead | G |

Parallel groups: A runs now (0, 1, 3, 4, 5, and 7 once the key exists). B
follows 1. C follows 1-3. D follows 7. E follows D and B. F follows E and C. G
last.

Not recommended: carrying a pending candidate grant through the plugin launch
contract so staging could run before the flip. It adds a contract field, a
Launcher change and a 24-hour operator grant per company and model, only to be
removed at the flip. Staging is the canary: item 11 exposes Antigravity on
staging only, and item 12 proves the Agent Computer path there before any
broader or production exposure (items 13 and 14).

## 7. Waiting on the owner

- **Paid Gemini API key** in the `runner-e2e-paid` environment's
  `GEMINI_API_KEY` secret. Waived as an item 8 flip blocker on 2026-11-25;
  still needed for deferred unattended paid-key CI runs (item 7).
- **Ledger rule:** accept either the API-key-only suite as written, or allow
  attended sign-in evidence for the lifecycle rows (section 4).
- **Production go-ahead** for item 14 (outward-facing).
- **Google terms:** legal read still pending (owner chose to proceed).
