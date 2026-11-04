# Live provider connections

`provider-connections` exercises real connection creation through the Apps catalog
or new-agent wizard, then verifies a real agent task and follow-up. It is an
explicit-only Product E2E suite. It is excluded from `--all` and the paid GitHub
matrix: subscription login initially runs attended on a developer's machine.

Tasks are submitted through the production composer. When it accepts only a
prompt, the harness assigns its fixture title through the public API. This
changes naming metadata only; execution, status, attachments and downloaded
bytes are produced and verified independently.

## Run one journey

Create a private JSON configuration outside the repository. Its values reference
credentials; do not paste keys into it. For example:

```json
{
  "target": { "mode": "managed-local" },
  "browser": {
    "headed": true,
    "channel": "chrome",
    "profileDir": "/absolute/private/path/provider-qa-browser",
    "accountAlias": "developer-qa",
    "freshness": "signed-in",
    "loginTimeoutMs": 600000
  },
  "secretFile": "/absolute/private/path/provider-qa.env",
  "models": { "codex": "YOUR_CODEX_MODEL", "claude": "YOUR_CLAUDE_MODEL" },
  "routes": {
    "openrouter": { "model": "YOUR_OPENROUTER_MODEL" },
    "bedrock": { "model": "YOUR_BEDROCK_MODEL", "region": "YOUR_AWS_REGION" },
    "responses": {
      "baseURL": "https://your-gateway.example/v1",
      "credentialEnv": "QA_RESPONSES_KEY",
      "model": "YOUR_GATEWAY_MODEL",
      "auth": "bearer"
    }
  },
  "budgetCents": 200,
  "maxRuns": 3,
  "turnTimeoutMs": 300000
}
```

The secret file must be an owner-only regular file (`chmod 600`), with literal
`NAME=value` entries. Only the selected variable is read. Shell substitutions
are rejected. Environment variables take precedence. Default names are
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, and `AWS_BEARER_TOKEN_BEDROCK`. Override direct-key names
with `credentials: {"codex": "DEDICATED_QA_OPENAI_KEY"}`. Subscription cases
read no provider API key and never import CLI credential homes.

Routes may be shared by method or overridden per harness, such as
`"claude.openrouter"`. Protocol gateways require their own explicit credential
reference, or `auth: "none"` for a deliberately unauthenticated endpoint.
Messages gateways also support `auth: "api_key"` (`x-api-key`). Bedrock requires
a current bearer token and region. The harness does not mint or refresh AWS
tokens. Missing credentials/configuration produce a blocked result.

```sh
pnpm test:e2e:runner -- --list --suite provider-connections
pnpm test:e2e:runner -- \
  --id provider-connections.connection-codex-native.local.agent-api-key \
  --connection-config /absolute/private/path/connections.json
pnpm test:e2e:runner -- \
  --id provider-connections.connection-claude-legacy.local.apps-subscription \
  --connection-config /absolute/private/path/connections.json
```

Start with one cell. Running `--suite provider-connections` selects all 116
eligible cells and can spend money; it does not make missing routes available.
Each command generates a separate campaign, preserving previous attempts.

## Authentication handoff

Playwright drives Paperclip and opens the real provider sign-in page. When login
needs a person, the terminal prints the provider and account alias and writes
`progress.json`. Complete Google/provider login, MFA, consent, and any code
entry in the visible QA browser. The test resumes only after Paperclip reports
a saved, connected credential. Do not paste passwords or OAuth codes into chat.

The QA browser uses its own private profile. It refuses an existing unmarked
profile, keeps a lock while running, and never uses your normal Chrome profile.
`signed-in` permits previously saved website login; it still creates a fresh
Paperclip connection. `signed-out` starts a temporary empty browser profile.
Paperclip SSO and provider SSO may share an identity provider, so this records
the browser's initial state, not a guarantee of another password challenge.

Human help is recorded as `assisted`. A login deadline records `awaiting_user`,
not a pass, and stops the selected campaign before opening another login.
Rerun the remaining cell IDs to start a fresh authorization after expiry;
resumption is within the running process, not across a stopped process.
Ctrl-C, termination, and hangup close the test browser pages, cancel recorded login attempts and active
runs, performs fixture teardown, records interruption, and stops the campaign.
Each cell has a thirty-minute outer deadline. A forced process kill cannot run
teardown; inspect the private QA profile lock and target fixtures before rerunning.
If Google rejects the automated browser, use the production device-code or
code-return flow in your normal browser. Grok's current production flow may
require the displayed terminal sign-in command. These are attended results.

## Local and staging targets

`managed-local` owns a fresh server/database and removes its data on shutdown.
To use an existing local server or staging, replace `target` with:

```json
{
  "mode": "attach",
  "baseURL": "https://YOUR-INSTANCE.staging.paperclip.app",
  "expectedCommit": "EXACT_40_CHARACTER_DEPLOYED_COMMIT_SHA",
  "deploymentMode": "authenticated"
}
```

For local attach use `http://127.0.0.1:PORT` and `local_trusted`. Health must
match the expected revision and deployment mode before credentials are read.
The target is never reset, restarted, or given instance-setting changes.
Sign in to Paperclip in the QA browser if needed; that session supplies the
same public API permissions as the browser. The operator needs company/agent
creation, connection management, and company archival permissions.

Deployment and execution environment are different dimensions. `.local.` means
the agent runs in the target's local environment, including a staging server's
local environment. `.daytona.` requires an already configured active Daytona
environment on the selected target; this suite does not provision one. Use
`target.companyId` and `target.environmentId` to select an empty dedicated
company named `Connection QA…` with that environment. For a new QA company the
harness uses the matching visible instance environment. Missing environments
or a disabled native runner are explicit target blockers.

Each cell creates a separate QA company unless one was supplied. Teardown
pauses its agents, cancels active runs, revokes its test connections, and
archives the created company. This avoids requiring hard-delete support on
staging and retains inspectable task history. Supplied QA companies must start
without active agents or usable connections; revoked connection records and
terminated agents from earlier attempts are allowed. Their new test agents are
deleted and test connections revoked; historical records may remain. `retainCompany: true`
keeps the fixture and credentials for diagnosis, with agents paused, and is
recorded explicitly in evidence. Clean it up before reusing that company.

## What qualifies as a pass

Every checkpoint must be verified:

1. Expected target revision and deployment mode.
2. Fresh connection saved with the selected method/provider/route.
3. Connection visible after navigating away and reloading Apps.
4. Agent created through the wizard with the selected harness/model/binding and requested execution environment.
5. Real Configure-page environment probe passes.
6. Real task run succeeds with that exact managed connection's attribution and requested environment in its durable run context.
7. Agent decodes random input bytes supplied in the task, computes their sum/count/hash, and delivers
   an attachment whose JSON is checked independently by the harness.
8. Tool evidence and attachment authorship/run attribution are present.
9. A browser-submitted follow-up reuses the connection and delivers independently
   checked minimum/maximum/sum output.

The oracle input is base64 in the task description and must be decoded with a
tool, preserving its exact bytes. This makes connection qualification independent
of new-task attachment ingestion. The earlier uploaded-input OpenRouter attempt
remains a failed attachment-path test: native staging currently admits chat
attachments, and the new-task dialog uploads its files after scheduling the agent.
Successful provider cells do not qualify that task-level upload path.
10. Downloadable artifacts remain visible after a page reload; cleanup succeeds.

An answer saying “provider routing works” cannot pass. Evidence records the
configured model and agent configuration; connection attribution proves the
selected credential, not an upstream gateway's internal model mapping.

The matrix covers Claude, Codex, Grok, Gemini, OpenCode, and Hermes local where
Paperclip's managed-connection capability table admits them, with applicable
legacy/native variants and both UI entry points. Cursor local, Kimi, and Pi
remain visible product gaps for managed connection onboarding. Remote OpenClaw
and Hermes gateways, Cursor Cloud, managed Claude/AWS AgentCore, process/HTTP,
and generic legacy ACPX are deliberately excluded.

## Reports, privacy, and CI

Results are under `tests/runner-e2e/results/connections-…/`: `dashboard.html`,
`campaign.json`, `normalized-results.json`, `connection-coverage.json`, `progress.json`, and packaged
per-cell evidence. The report uses the existing Product E2E grader, billing,
history, and dashboard. Coverage reports required/selected/attempted/passed
counts separately. A partial local campaign does not qualify staging or the
whole matrix. Blocked credentials/login are incomplete; cleanup failures fail.

No Playwright traces, HARs, videos, automatic screenshots, raw assertion call
logs, OAuth URLs/codes, or provider transcripts are retained. Only the final
synthetic task can be screenshotted; it is private and has no public publication
marker. Auth browser state stays outside the repository. Keep reports private.
The result includes source revision, target revision, suite definition hash,
model, method, assistance, run IDs, checkpoints, timing, and numeric usage.
Before removing a managed instance, the harness retains terminal run status,
log availability, and closed diagnostic codes for recognized quota, overload,
file-conversion, session-configuration, or shell-restriction failures. It reads
error records and failed tool receipts only; messages, stderr, model output,
and reasoning are not copied into the result. An empty signal list leaves the
cause unknown. Missing logs remain explicit and do not imply a healthy run.
Attached-company cleanup captures these diagnostics after stopping runs and
before deleting the fixture agent, since agent deletion also removes its logs.
Cleanup revokes only this attempt's account IDs from successful creation or
owned sign-in receipts. Concurrent campaigns' accounts are never adopted or
revoked, even if both campaigns initially observed an empty QA company.
UI probes may incur unreported spend, so billing is explicitly partial.
Regenerate the report from retained results with
`pnpm test:e2e:runner:dashboard -- /absolute/path/to/connections-campaign`.

API-key cells can run headless (`browser.headed: false`, `channel: "chromium"`)
on trusted CI once the target's board authentication is provided through a
dedicated QA browser session. Subscription cells require headed mode and a
person when challenged. Dedicated subscription accounts and a trusted attended
runner are the next operational step; normal untrusted PR jobs never get these
credentials. Credential-free support tests and catalog checks run separately:

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
```

The opt-in cancellation smoke uses a synthetic loopback page and cookie, with
no provider calls or credentials. It verifies that Ctrl-C, termination, and
hangup leave the browser's authenticated API client usable until fixture cleanup
finishes: `pnpm exec tsx tests/runner-e2e/connection-cancel.smoke.ts`.

## Initial verification (2026-10-03)

The local native Codex/direct OpenAI key/new-agent cell completed both real
artifact turns with exact connection attribution and successful cleanup. The
Apps/OpenRouter/native Codex cell created and reused its connection and passed
its setup probe, then failed the task proof: its agent could not retrieve the
uploaded input and marked the task blocked. This is not a gateway qualification
pass. The Claude legacy/Apps subscription journey opened real sign-in and
exercised the bounded `awaiting_user` outcome; login was not completed.

Credential-free verification: runner E2E typecheck, 855 support tests, both
updated simulated local-browser-login regressions, catalog discovery, and
retained-report regeneration passed. A fresh managed-local server was started
and removed with an intentionally missing credential; no provider was called.
Staging and the remaining cells have not been qualified. Use the generated
campaigns for the exact revision, definition hash, timestamps, and results.

## Local follow-up (2026-10-05)

Every eligible non-subscription local cell was attempted against the existing
onboarding instance, preserving its original company data. The latest retained
attempts now contain 43 passing journeys out of 46 non-subscription cells,
including the Gemini investigation on October 6:

| Harness | Passing key/gateway journeys | Eligible local key/gateway journeys | Remaining result |
| --- | ---: | ---: | --- |
| Claude | 16 | 16 | Direct key, OpenRouter, Bedrock, and Messages passed through both entry points and runner generations. |
| Codex | 12 | 12 | The legacy/new-agent OpenRouter task and follow-up passed after the skill-root and artifact-helper fixes. |
| OpenCode | 8 | 8 | All three remaining OpenRouter journeys passed after the artifact-helper and canonical-workspace permission fixes. |
| Hermes local | 4 | 4 | A follow-up interrupted by lease release passed on one bounded retry. Workspace isolation was then corrected and retested separately. |
| Grok | 2 | 4 | Both legacy API-key journeys passed after preserving private session history and avoiding remote subscription restoration for missing local history. Native journeys require the missing pinned runtime. |
| Gemini | 1 | 2 | New-agent/API-key passed with `gemini-3.5-flash-lite`; Apps/API-key delivered its first artifact but timed out on follow-up. Installed CLI file creation still fails the isolated compatibility check. |

There are another 12 local subscription cells. Attended Claude/OpenAI attempts
opened real authorization and reached their human handoff, but have not qualified
a completed subscription journey. Staging and Daytona remain untested. The
Responses and Messages gateway proofs used the official provider endpoints;
they do not qualify an Emissary deployment or every compatible gateway.

The run exposed a real new-agent loading race: an early API-key selection could
be discarded when environment settings finished loading and remounted Connect.
Connect now waits for those settings before exposing interactive choices. Saved
connection selectors and native OpenCode model normalization were repaired in
the harness; original failures remain in their original campaigns. Native
OpenCode no longer sends the deprecated per-prompt tools override, which replaced
its session permission policy; its remaining live OpenRouter failures were subsequently fixed and retested below.

Hermes also ignored the assigned task workspace when an agent had no explicit
`cwd`, writing proof files into the server checkout. It now uses the resolved
task workspace as its default. Explicit directory overrides retain their existing
behavior. The real retest checks that the local proof file is in the assigned
directory and matches the independently downloaded artifact. Earlier checkout
spill files were preserved privately outside the repository.

An interrupted subscription attempt exposed another cleanup bug: Playwright's
default signal handler closed the browser before the harness could cancel the
login using its authenticated API client. The harness now owns browser shutdown,
and a real-browser smoke verified cleanup under SIGINT, SIGTERM, and SIGHUP.
One cancellation state now covers the entire campaign, including target startup,
report generation, and teardown. Credential-free regressions verify that all three
signals stop further cells during startup and reporting and still stop the owned
target. Signal handlers remain installed until teardown finishes.
An expired human handoff also stops the campaign instead of opening the next
subscription window. The affected attempt remains failed in the evidence; its
login was cancelled and its disposable company archived through the public API.
The cleanup audit covers all 113 disposable companies and confirms that the
original onboarding company remains available.

Hermes was tested using an isolated official CLI installation. Its temporary
PATH launcher was removed after qualification; replay requires Hermes to be
installed on the tested server's PATH. The report records the tested CLI version
and source commit in `qualification-environment.json`.

Credential-free verification passed: runner E2E typecheck and all 856 support
tests, 46 new-agent UI tests, 39 native OpenCode driver tests, 10 Hermes invocation
tests, runner/Hermes package typechecks, and UI token gates. After the final
browser signal change, runner E2E typecheck, 13 connection support tests, and the
three-signal browser smoke passed again. This initial qualification stage did
not repeat repo-wide typecheck, tests, and build; later verification is recorded
below.

### Credential follow-up, evening of 2026-10-05

The xAI dashboard identified expiry as the original key rejection: its QA key
expired on September 27. The existing key was renewed for 90 days, through
January 3, 2027, preserving its scope and limits. A Gemini replacement was saved
in the owner-only secret file; the temporary exposed key was revoked and its
absence verified after a dashboard reload. No provider billing settings changed.
Both provider model-list requests returned HTTP 200. A separate bounded Gemini
generation request succeeded with `gemini-3.8-flash`; the older
`gemini-2.5-flash` request returned HTTP 404. Model-list success alone does not
qualify inference or a product journey.

Six previously credential-blocked cells were rerun, followed by three bounded
Gemini attempts after new diagnostics and a selector repair. At that stage none added a fully
qualified journey, leaving 36 of 46 local key/gateway cells passing. Those 91
attempts and the subsequent repair attempts remain inspectable. These evening
campaigns have October 6 UTC timestamps and belong to the developer's October 5
local qualification date.

- Grok legacy, both entry points: the first task delivered an independently
  verified artifact. Each follow-up reported its session absent locally,
  attempted remote conversation restoration, and waited for subscription device
  authorization during an API-key journey. Investigate preserving isolated
  non-credential session state across disposable managed credential homes.
- Grok native, both entry points: connection creation and reload passed, but
  Configure was not reached. An independent non-inference installation probe
  confirmed the required Grok Build 1.0.13 executable was missing. Provision it
  using the checked-in helper in `doc/grok-native-runner.md`, then rerun those
  exact cells; retain the runtime integrity checks.
- Gemini: `Auto` completed ACP startup but timed out before task output. With
  `gemini-3.8-flash`, both entry points created and reloaded a connection, passed
  setup, and started the real task, then failed with
  `acpx_session_config_failed`. Installed Gemini CLI 0.58.0 rejected
  `session/set_config_option` for the model with ACP `-32601` (Method not found).
  Resolve that runtime compatibility before claiming a pass. The Apps selector
  now reads the shared app definition's name (`Google Gemini`); its original
  selector failures remain retained.

After the catalog selector repair, runner E2E typecheck and all 13 connection
support tests passed. The final cleanup audit found no usable QA connections,
active QA agents, or active QA runs; the original onboarding company and test
server remain available. The private report includes `credential-refresh.json`,
`key-retest-diagnostics.json`, `gemini-generation-probe.json`, and
`cleanup-audit.json`. None contain credential values or authorization codes.

The private `connections-qualification-2026-10-05` dashboard selects the newest
attempt per cell. `retained-attempts.json` and `attempts.md` retain all original
campaigns. Source and suite definition hashes are preserved: these runs span
harness repairs and an uncommitted working tree, so their passing count is
historical evidence, not a common-build release qualification. Commit the reviewed
fixes and rerun the required cells against that exact deployed revision before
claiming the whole feature qualified.

### Repair verification, late evening of 2026-10-05

The previously failing Codex OpenRouter journey, both legacy Grok API-key
journeys, and all three OpenCode OpenRouter journeys now have passing browser
retests with independently downloaded artifacts and successful follow-ups.
Original failures remain in the report; no assistant success message alone
qualifies a journey.

The fixes refresh Codex's current skill root on resumed turns, keep artifact
helper temporary files inside the selected workspace, allow native OpenCode's
assigned workspace under both its supplied and canonical filesystem paths,
and keep credentials disposable. Missing managed local Grok history starts a
fresh task handoff instead of triggering remote subscription recovery during an
API-key turn.

On 2026-10-06, host-side Grok transcript retention/restoration was removed after
security review: other agents running as the same OS user could read restored
transcripts regardless of private file modes. Managed Grok follow-ups now start
fresh with the Paperclip task handoff. The historical Grok passes above precede
this change and do not qualify current transcript continuation; an isolated
history solution and new live qualification remain required.

Gemini now receives its selected model through `GEMINI_MODEL` before ACP startup
instead of an unsupported `session/set_config_option` call. Real tasks confirmed
startup and tool execution. The original `gemini-3.8-flash` attempts subsequently
hit daily inference quota; a small request for `gemini-3.1-flash-lite` succeeded.
These are distinct from model-list and connection-probe success.

Local Gemini turns now also receive the current selected skill root and
explicit instructions to read the Paperclip artifact workflow before making
control-plane calls. A real follow-up exposed Gemini CLI's rejection of inline
command substitution when building a JSON completion request. Its local turn
guidance now uses workspace JSON body files with `curl --data-binary @file` or
the selected skill's helpers; the shell restriction remains in place. Regression checks cover current roots across disposable
homes for both Codex and Gemini. The shared ACP regression file now passes all
214 tests after isolating Gemini test homes from the developer's CLI state and
adding canonical-workspace and remote-workspace regressions.

A credential-free real ACP reproduction isolated two filesystem compatibility
problems behind Gemini's file-write errors. The client now translates a genuine
missing-file read into the correct ACP resource-not-found error. This verifies
the client protocol response; the installed Gemini CLI still mishandles that
response, as isolated below. Local Gemini sessions also bind the filesystem client to
the canonical workspace directory. Remote workspace paths are preserved. The
existing ACPX dependency patch and its lockfile hash contain this narrow fix;
four real protocol regressions cover missing-file semantics, external path denial, deny-all
permissions, and other filesystem errors. The full affected ACP group passes
221 tests, including the existing three spawn safeguards. An earlier combined
verification failure and the failed browser attempts remain retained.

The final filesystem-fix campaign (`connections-2026-10-06T04-50-27-196Z-1ec2a9`)
still failed both Gemini entry points at the unchanged 300-second first-task
deadline. Connection creation, reload, Configure probe, and binding passed.
The new-agent turn created its local proof files, but neither turn completed
the successful run, uploaded-artifact, and follow-up qualification. The earlier
filesystem and model-configuration errors were absent from these tool receipts;
that does not qualify the full workflow. Further work must investigate Gemini
task execution latency and skill use with the configured CLI/model, then rerun
the same independent oracle. No timeout increase or cancelled-run pass was used.

A further Gemini attempt exposed a harness settlement race: the first successful
turn did not attach the file, while an automatic disposition-repair run did.
The harness now waits for active repair runs within the existing configured
limits and selects the successful run that actually uploaded the required file.
It still rejects cancelled runs, wrong connection/agent attribution, wrong
artifact bytes, and exceeded run/cost limits. The repair-attribution regression
suite passed (58 tests across the targeted support/catalog files).

The task-composer helper was updated for the current production controls and
its remembered project selection. A credential-free real browser smoke proved
Plan and Ask mode, assignee/project selection, fixture task naming, and file
upload. Public-API title updates only name fixtures; execution, credentials,
model selection and artifact delivery remain real product behavior.

Full workspace typecheck and build passed. UI token gates and shell syntax
passed. The broad Vitest attempt did not produce a green full-suite result:
stale catalog/pool assertions were corrected and checked narrowly, while
additional worker-start, hook and process timeouts remain recorded. Serial
adapter/server rechecks were interrupted after more deadline failures; they do
not constitute a passing full-suite run. UI/CLI and
shared/database/skill-catalog groups passed. Further isolated checks do not
substitute for a successful complete PR verification run.

The pinned native Grok executable is still absent at
`/opt/paperclip/providers/grok/1.0.13/grok`. Installing it needs administrator
access; retain the checked-in provisioning helper and its checksum verification.
Subscriptions, staging/Daytona, and common-build release qualification remain
outstanding.

## Gemini investigation (2026-10-06)

The installed Gemini CLI is 0.58.0. A credential-free check now exercises its
actual ACP file tools against the patched ACPX client, with a loopback model
response and disposable home/workspace:

```sh
pnpm exec tsx tests/runner-e2e/gemini-acp-filesystem.smoke.ts
```

On the stock CLI, reading an existing file and rejecting an external write pass;
creating a new file fails. Its ACP SDK rejects a plain JSON error object, while
`AcpFileSystemService.normalizeFileSystemError` reads the message only from an
`Error` instance. Consequently it misses the genuine resource-not-found message
and fails the initial read-before-write. The same implementation is present in
the [upstream source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpFileSystemService.ts).
A temporary copy that also reads a plain object's string `message` passes all
three checks. The installed CLI has not been changed, and the real browser
qualification uses the stock CLI. A workflow that recovers using shell tools
does not qualify the broken native file tool.

Retained child-stderr metadata also confirms HTTP 503 overload retries in the
earlier deadline failures. A bounded availability probe returned HTTP 503 for
`gemini-3.8-flash` and valid HTTP 200 output for `gemini-3.5-flash-lite`.
With Flash-Lite, the full new-agent/API-key journey passed, including two
independently downloaded and verified artifacts and an attributed successful
follow-up. The initial Apps/API-key journey created, reloaded, tested, and bound
the connection, then failed its first task. It did not retain a cause before
managed-instance teardown; that gap prompted the closed diagnostic projection
above. One diagnostic retest (`connections-2026-10-06T13-25-36-718Z-20ee5d`)
delivered and independently verified the first artifact, then exceeded the
unchanged 300-second follow-up deadline. Both run statuses and log availability
were retained before cleanup, but neither log contained a recognized error
signal. The follow-up cause remains unknown; overload in other runs is not
proof of overload in this run. No deadline or oracle was relaxed.

The CLI requests `HIGH` thinking by default. Short bounded comparisons did not
establish that default thinking causes the long workflow delay. Explicit effort
configuration still uses an ACP method this CLI rejects; supported startup
`modelConfigs` settings need a separate adapter fix and local/remote validation.
Do not silently drop the user's setting or claim that a model-list/setup probe
qualifies execution.

The original 3109 instance is currently stopped, and its temporary config and
encryption key are missing. Its database was left untouched; substituting a new
key would not recover the existing credentials. Fresh investigation campaigns
use managed instances with separate databases and keys, archive their owned
companies, and remove their owned servers. The private consolidated report
retains all earlier failures, exact model/source provenance, and
`gemini-investigation.json`. These mixed working-tree attempts do not qualify
staging or a common committed release build.
