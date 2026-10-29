# Antigravity additional-agent journey

`antigravity-agent-journey.runner-antigravity.local.saved-subscription-two-turn`
converts the recorded 38-step setup/first-task and 9-step follow-up into one
explicit-only Product E2E cell. It is excluded from `--all` and scheduled paid
matrices. The [conversion brief](../../doc/plans/2026-10-29-antigravity-journey-to-eval.md)
records all 47 source-step dispositions, immutable source hashes, original grades,
earlier failures and evidence limits.

The fixed browser driver starts on the company dashboard, follows Agents → New
Agent, selects Google Antigravity in the ordinary grid with Advanced collapsed,
reuses the saved personal Google subscription, selects the exact low model and
Local environment, and runs the native prompt-free Test. Finish must reach actual
readiness before task assignment is enabled. It checks the first composer for a
stale paused warning, closes that empty composer, saves a nonce only through the
agent's Instructions, then submits a task asking for the configured marker without
supplying its value. An ordinary follow-up asks the same agent/task to preserve the
first line and append a different nonce. Each real file and Done state must remain
available after reload.

## Selected setup and dependencies

The runnable setup attaches to an existing **self-hosted loopback target on the
same macOS ARM64 host**. This narrower implementation lets the independent native
observer verify owned process retirement and all three public-checkpoint provider
lifetime fences. `.local.` identifies agent execution. It does not itself identify
application hosting. Compatible Cloud/staging behavior remains a portability
target, not an implemented or verified remote observer path.

Required existing state:

- A dedicated test company and local execution environment; expected and observed
  serving commit and deployment mode must match. The harness never resets or
  restarts an attached target. Its roster already contains a nonterminated agent,
  so the measured creation is an additional-agent path.
- A dedicated signed-in QA browser profile for the intended board operator, with
  company agent/instruction/task creation and saved-connection use rights. The
  normal profile ownership marker and exclusive lock apply; do not use a normal
  personal Chrome profile.
- The same person's saved managed Google subscription, with its existing personal
  default grant. The private setup names exact connection, owner, company and
  environment references. Names alone do not establish the binding.
- A current, finite **trusted operator startup admission** for that company,
  `gemini-3.8-flash-low`, local darwin-arm64, native version, profile and closure.
  The config's pins assert provenance; they cannot grant admission. The global
  release remains pending and closed by default.
- Current budget policy permitting the two bounded task turns, with held and
  unpriced usage reconciled through the ordinary accounting owner. A monetary
  limit does not cap unknown subscription charges.

No MCP connection is required by the browser driver, product agent or independent
observer. Native product tools are used by the agent. No API key, mailbox,
billing-management credential, fresh Google login or OAuth registration is part
of this case. Authentication freshness is **saved browser session + saved product
connection**, not fresh provider consent. Product-managed refresh stays inside
the normal managed-account boundary.

After verified native retirement, a refreshed Google credential transfers to the
existing encrypted, fsynced recovery journal before database rotation. The next
authorized task, Test or model discovery recovers it with the same grant,
generation and account checks. A failed journal write or unconfirmed retirement
keeps the private home and blocks cleanup; a retry does not grant new authority.

One-time test-drive/bootstrap setup remains the operator's supported workspace
owner responsibility. This suite does not implement a managed-local target
bootstrap, mint candidate authority, install a provider through a test-only path,
or import an operator's CLI credential home. Install the maintained native assets
through `paperclipai runtime setup antigravity` as the OS user running Paperclip.
Then use the existing product UI to establish the saved account once. Per-attempt
preflight verifies those declared prerequisites; the measured **new agent** must
remain absent until the visible creation flow.

## Private setup file

Create an owner-only regular JSON file outside the repository (`chmod 600`).
Replace every placeholder with an authorized binding; never put token/cookie,
password, OAuth code or startup authority bytes in it. Relative `profileDir` is
resolved against this file's directory. The browser must declare `signed-in`.

```json
{
  "version": 1,
  "setupId": "local-antigravity-saved-subscription",
  "hosting": "self-hosted",
  "executionEnvironment": "local",
  "target": {
    "mode": "attach",
    "baseURL": "http://127.0.0.1:YOUR_PORT",
    "expectedCommit": "EXACT_40_CHARACTER_SERVING_COMMIT",
    "deploymentMode": "local_trusted",
    "companyId": "EXISTING_TEST_COMPANY_UUID",
    "environmentId": "EXISTING_LOCAL_ENVIRONMENT_UUID"
  },
  "browser": {
    "headed": true,
    "channel": "chrome",
    "profileDir": "./qa-browser",
    "accountAlias": "browser-operator",
    "freshness": "signed-in",
    "loginTimeoutMs": 600000
  },
  "savedConnection": {
    "id": "EXISTING_GOOGLE_CONNECTION_UUID",
    "name": "YOUR_SAVED_SUBSCRIPTION_LABEL",
    "ownerUserId": "EXPECTED_BROWSER_USER_ID"
  },
  "candidate": {
    "platform": "darwin",
    "architecture": "arm64",
    "nativeVersion": "1.4.3-paperclip.5",
    "profileDigest": "sha256:acf5f574b6b9ec4388ff9d081890caa330e66bf1ae3fe3b08e7f0fb0e851b9ce",
    "nativeClosureDigest": "sha256:044792d793e203bc8b4524a418f1816c4d34db67bb41fa4bae5947a050c49b4a"
  },
  "limits": {
    "durationMs": 1200000,
    "turnTimeoutMs": 300000,
    "maxRuns": 2,
    "budgetCents": 200
  },
  "retainAgent": false
}
```

Use `authenticated` when it is the target's actual deployment mode; do not change
the server to match the example. The maximum whole attempt is 30 minutes, each
turn at most 10 minutes, and configured budget at most 1,000 cents. Exactly two
work runs are permitted. Native Test performs account/model admission and cleanup
without a model prompt. An unexpected work run or inference edge must be recorded,
not omitted from accounting.

## Commands

Run from the Paperclip repository root, with its normal workspace dependencies
installed. The maintained source files own all behavior; no author-local helper
script is required. Discovery and credential-free checks do no provider work:

```sh
pnpm test:e2e:runner -- --list --suite antigravity-agent-journey
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
```

Read-only readiness validates the target revision/mode, signed-in consuming
identity, exact personal default grant, local environment and candidate catalog.
It does not run native Test, create a task or dispatch a provider prompt:

```sh
pnpm test:e2e:runner -- \
  --id antigravity-agent-journey.runner-antigravity.local.saved-subscription-two-turn \
  --antigravity-journey-config /absolute/private/antigravity.json \
  --antigravity-journey-preflight \
  --max-automatic-retries 0
```

After readiness, run only the exact authorized cell. A new campaign preserves
previous attempts and uses no automatic retry:

```sh
pnpm test:e2e:runner -- \
  --id antigravity-agent-journey.runner-antigravity.local.saved-subscription-two-turn \
  --antigravity-journey-config /absolute/private/antigravity.json \
  --max-automatic-retries 0
```

Campaigns live under
`tests/runner-e2e/results/antigravity-journey-<timestamp>-<nonce>/`. Retain their
normal result, evidence manifest, checkpoint images, actual byte/hash receipts,
timings, effective setup/revisions, billing and cleanup alongside failures. Run
the **normal importer separately** to verify a retained report; it makes zero new
model calls. Environment variables, not positional report arguments, select it:

```sh
PAPERCLIP_RUNNER_E2E_REPORT_ROOT=/absolute/private/campaign \
PAPERCLIP_RUNNER_E2E_REPORT_OUT=/absolute/private/rebuilt-report \
PAPERCLIP_RUNNER_E2E_EXPECTED_IDS='["antigravity-agent-journey.runner-antigravity.local.saved-subscription-two-turn"]' \
  pnpm test:e2e:runner:report
```

The importer must preserve the attempt verdict, cleanup outcome, duration, known
input/output/cache tokens and unknown prices. A rebuilt dashboard is a
presentation check, not another provider measurement. Missing final proof cannot
be repaired by inventing a screenshot or rewriting an old grade.

## Independent acceptance and retained evidence

Success requires the correct browser controls and persisted object identity,
exact actual downloaded bytes for both distinct run-bound artifacts, requested
and effective low model, same full tagged native conversation, accepted result,
committed finalization and an applied Done decision for each own settlement.
The first settlement is captured before reopening; later legitimate reassessment
may supersede its current pointer without invalidating that historical lineage.
The final task's visible status and both outputs must survive reload. Narrative
claims, hidden status labels, a matching filename or a stale first artifact do not
satisfy those gates.

Native public lease release, exact owned process absence and reacquisition/release
of all three observed provider fence ports establish local retirement. The
observer reads no private database or raw provider reasoning. Its exact local
target constraint is part of the case, not portable host proof. A genuine failed
finish remains failed while prior successful native file activities stay
completed; the happy path does not deliberately manufacture that rejection.

Synthetic positive/negative/missing-proof controls use the same oracle and normal
report boundary. They cover wrong object/run/model/conversation, stale or wrong
bytes, incomplete settlement/retirement, missing final screenshot and unknown
price preservation. Browser calibration includes hidden duplicate/menu/SVG Done
text beside the intended visible task status. Synthetic fixtures establish these
gates, not Google behavior or discoverability.

Raw authenticated setup screenshots, concrete account/company/agent/task/native
session identifiers, browser state and ownership receipts stay private. Do not
mark these captures `public-runner-fixture`, publish original walkthrough HTML,
or copy provider payloads into public evidence. Source aliases and hashes are
safe provenance; any public projection remains the existing sanitizer's allowlist.

## Cleanup and interrupted recovery

The campaign journals `owned-resources.json` as measured creation succeeds,
before later task dispatch. The receipt binds target/company, execution/attempt
and immutable created resources. Cleanup stops only owned active work, verifies
settlement and native retirement, then pauses/removes the owned agent according
to `retainAgent`. Supplied company/environment/browser identity and saved Google
connection/default grant remain intact and are reverified. It never revokes a
shared credential or resets the target. Retained task history remains inspectable.

A Test that fails or times out before the product confirms probe retirement leaves
its setup probe marked unconfirmed. The harness keeps that agent paused and
retained. Public task-run absence cannot prove that a setup probe has retired;
recovery needs authoritative proof from the product cleanup owner.

On interruption, preserve the result and receipt first. Recover with the same
private target binding and the exact receipt; no name-based broad cleanup:

```sh
pnpm test:e2e:runner -- \
  --id antigravity-agent-journey.runner-antigravity.local.saved-subscription-two-turn \
  --antigravity-journey-config /absolute/private/antigravity.json \
  --antigravity-journey-recover /absolute/private/campaign/owned-resources.json \
  --max-automatic-retries 0
```

Recovery validates ownership before stopping recorded/new owned-agent runs or
removing its agent. An uncertain mutation is reconciled before retrying. Cleanup
failure stays separate from primary failure; late recovery produces a separate
receipt without upgrading the original cleanup grade. Do not start another paid
attempt while owned work or the browser profile lock remains unresolved.

## Verification scope

The source `.5` browser walkthrough and independent retained oracle passed on the
declared attended local saved-subscription/low-model candidate. Native instruction
wire receipts were not archived; Instructions-only provenance plus actual file
bytes proves resulting behavior. HTML gallery navigation was blocked by the
host's local-file preview policy and is unverified. Earlier failed/partial `.4`
and package-admission attempts retain their original grades.

The converted fixed driver, credential-free calibration, fresh live attempt and
normal report results are recorded separately in PR/attempt evidence. A registry
listing or unit pass does not qualify a live provider. Fresh OAuth, API-key live
operation, Cloud, staging/remote targets, other models/platforms, failure controls,
reliability repetitions and unattended execution remain outside this selection.
