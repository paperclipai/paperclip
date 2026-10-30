# Runner E2E security for a public repository

The explicit [chat feature evals](CHAT-FEATURES.md) use synthetic project briefs
and a privately supplied Codex subscription login through the existing isolated
company staging helper. Only source-chat screenshots are captured. Task, document
and run evidence stays behind the existing sanitizer and publication allowlist;
the YAML catalog contains no credentials. The suite's accounted-work budgets do
not cover production setup probes or imply zero subscription cost.

[Cloud Product journey bundles](PRODUCT-JOURNEYS.md) are always private and
rejected by public history publication. Authentication uses an isolated browser
context without saved storage state or auth tracing. Only closed error codes
and normalized operations receipts cross the private target-provider boundary.
The private Cloud repository owns operator credentials, conditional S3 leases,
ownership manifests, cleanup recovery, and environment-protected CI dispatch.

Cloud onboarding retains only the independently checked synthetic
`connection-proof.json` download (at most 4 KiB) and its closed oracle receipt
inside private normalized results. The receipt contains generated numeric inputs,
their expected four-field result, exact base64 download bytes, checksums, size,
and attachment/run IDs. Extra fields and arbitrary agent output are rejected.
It contains no credentials, browser state, request headers, or provider text.

The optional `onboardingConnect` diagnostic is also a closed, versioned receipt.
It retains only a known checkpoint, response states, HTTP statuses, known adapter
names, and allowlisted outcome/check/server codes (at most 32 checks per response).
Unknown codes become `unrecognized`; raw bodies, messages, URLs, headers, and
browser errors are excluded. Reports validate the receipt before rendering its
explicit fields, and historical results may omit it.

The optional `onboardingPreAcceptance` receipt captures only a failing first-task
acceptance guard. Its closed version-1 fields are a known checkpoint, up to four
distinct guard-violation codes, nonnegative integer task/attachment/document
counts, a canonical-parent match boolean, and closed first-task/canonical-parent
statuses (`missing` and `unknown` remain explicit). It excludes all identifiers,
task text, document keys and bodies, filenames, URLs, credentials, and raw API
responses. Validation rejects extra or inconsistent fields before report use;
older results may omit the receipt. It preserves the original failure grade and
does not attribute a product cause or authorize acceptance.

## Attended connection authentication

The [Antigravity saved-subscription journey](ANTIGRAVITY-AGENT-JOURNEY.md) attaches
only to its declared same-host loopback macOS ARM64 test target. Configured pins
assert the trusted startup candidate authority; they cannot create it. The
signed-in browser user must own the exact pre-existing personal default Google
grant. No provider secret or OAuth code enters test configuration or prompts,
and no MCP connection is required. Ownership receipts, actual authenticated
screenshots and concrete account/session bindings stay private and receive no
public-fixture marker. Recovery validates target/company/execution and immutable
owned resources, stops only owned work and retains the supplied Google account
and default grant. It neither resets the attached instance nor clears accounting
holds. Two work turns, finite deadlines and zero automatic retries bound the
selected cell; unknown subscription prices remain unknown.

See [PROVIDER-CONNECTIONS.md](PROVIDER-CONNECTIONS.md) for the explicit-only
`provider-connections` suite, local/staging target ownership, dedicated browser
profiles, credential handoffs, private evidence, and cleanup contract.

`ConnectionApi.postSensitive` keeps credential bodies outside Playwright traces.
Adapters must preserve this transport when wrapping APIs. Its optional abort
signal and bounded timeout stop the actual HTTP request; setup cleanup must
wait for that request to retire before it certifies resource absence.

Provider-connection results may retain closed diagnostic codes and terminal run
status before managed-instance teardown. Only error records and failed tool
receipts are inspected; raw error messages, child stderr, model output and
reasoning are not retained. Unknown causes and unavailable logs stay explicit.
The optional installed-Gemini filesystem smoke uses synthetic credentials and
loopback model responses, makes no real provider calls, and removes its
disposable home/workspace.

The explicit [public MCP suite](PUBLIC-MCP.md) also creates a disposable browser
account and OAuth grant. Signup and token exchange use Node fetch, credentials
stay outside model context, and dynamic cookie/code/token values join the
attempt's redaction set. Tracing, video and automatic screenshots are disabled
for that suite; only reviewed fixture task routes may produce public screenshots.
External API evidence retains visible answers and tool outcomes, never raw model
reasoning. Empty provider configuration directories prevent operator plugins and
MCP credentials from being inherited. All grants are revoked during cleanup and
the launcher removes the isolated database and provider homes.

This suite can spend provider money, expose selected local and workflow API credentials to isolated
test processes, publish a container, retain private visual evidence, and write
public structured evidence. Treat changes to the workflow, harness, fixture
prompts, evidence packager, and publisher as security-sensitive production
changes.

## GitHub authorization

The Everyday remote native restart oracle reads only the existing public run,
event, environment-lease, workspace-operation and recovery APIs. It does not
execute commands in a provider sandbox or signal a provider process. Its new
evidence projects closed receipt metadata and hashes the provider sandbox ID
and full native event content. Provider text, tool arguments and command output
do not enter these snapshots. Existing image admission, credentials, billing,
retention and cleanup rules continue to apply.
The isolated server's private restart request may delay its replacement by at
most five minutes. This fault injection never stops a hosted instance or a
provider sandbox. The explicit Daytona continuity suite has one attempt and
1,000-cent company and agent hard stops.

Set `RUNNER_E2E_ALLOWED_ACTOR_IDS` to a non-empty JSON array of numeric GitHub
user IDs. Keep the list equal to the owners of `.github/**` in
`.github/CODEOWNERS`. For example, use `[123456,789012]`. Resolve each ID from
the authenticated CLI and verify the login before adding it:

```bash
gh api users/LOGIN --jq '{login,id}'
```

The paid workflows reject manual dispatches when the workflow definition does
not come from the default branch. A trusted dispatcher may name any branch in
`paperclipai/paperclip` as the code under test. The authorization job resolves
that branch through the GitHub API and passes only its immutable commit SHA to a
credential-free target-lock job. That job checks out the commit, regenerates
`pnpm-lock.yaml` once with lifecycle scripts disabled and lockfile-only mode,
then uploads the file under a run-attempt-scoped artifact ID. Catalog, image,
shared-build, provider-pack, and paid test jobs download that exact artifact by
ID, verify its recorded SHA-256, and restore it before setup or a frozen
dependency install. The lock resolver receives no provider credentials and
must never run repository lifecycle scripts. The shared-build and provider-pack
jobs also receive no provider credentials and disable dependency lifecycle
scripts; they package outputs with SHA-256 sidecars that consumers verify
before extraction. The paid test job installs with lifecycle scripts disabled,
and materializes the exact pinned OpenCode executable from its lockfile-verified
optional package without invoking package lifecycle code. Provider secrets are
scoped only to the final test step rather than dependency setup. Report sanitization and AWS
history publication explicitly use the trusted workflow commit and do not
consume the target lockfile. Never run the workflow definition from the target
branch.

The workflows verify both the original actor and triggering actor for every
scheduled or manual attempt, including human reruns. Every
secret-bearing job repeats this check as its first step so GitHub's partial-job
rerun feature cannot bypass a successful predecessor authorization job. The
legacy manually dispatched E2E workflow uses the same gate. Numeric IDs are
stable across username changes and prevent lookalike-name authorization.

The full-stack and live campaigns have one Sunday UTC schedule each and also
support explicit manual dispatch. Their legacy-named nightly repository
variables remain independent kill switches. Neither paid workflow accepts
pull-request, push, workflow-run, or reusable-workflow triggers.

Protect the default branch, require review for workflow/harness paths, restrict
workflow dispatch permission, and restrict repository variable/environment
administration to the same trusted maintainers. Configure the organization to
allow only approved GitHub Actions. A malicious change merged into the default
branch executes with the same authority as the suite.

Every external action in the paid workflow is pinned to a full commit SHA. Keep
the adjacent major-version comment for update tooling, and resolve and review a
new immutable SHA before upgrading an action. The credential-free security test
rejects mutable tag or branch references.

## Secrets and protected environments

Explicit Grok subscription campaigns may select `GROK_AUTH_JSON` from the same
protected paid environment. Deliver it only to that subscription profile's paid
test step. Prefer a dedicated test-account login and refresh it before a campaign.
The fixture stores only the selected login in its disposable company home, rejects
ambient/redirected homes, and removes the login during teardown. Token fragments
and account identifiers inside its JSON join the evidence redaction set. The
subscription suite remains manual-only and never falls back to `XAI_API_KEY`.

Create `runner-e2e-paid`, restrict deployments to the default branch, and put
only provider credentials needed by the selected paid suites, including
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`,
`COPILOT_GITHUB_TOKEN` and `DAYTONA_API_KEY` in it. Copilot is passed only to
cells selecting `credentialName: COPILOT_GITHUB_TOKEN`, in the paid Product or
direct-protocol execution step. Never expose it to ordinary PR, build, catalog,
image or report jobs. `KIMI_MODEL_API_KEY` remains a local-only catalog name
for pending explicit profiles and is intentionally absent from the workflow
environment. Product E2E pending-profile admission remains gated separately.
Do not duplicate these credentials as repository- or
organization-level Actions secrets: environment scoping is the boundary that
prevents branch or pull-request jobs from requesting them. Require approval
from an account in `RUNNER_E2E_ALLOWED_ACTOR_IDS` for this environment and
disable administrator bypass. The authorize, target-lock, catalog, image,
report, history, and Pages jobs receive none of these secrets.
Each full-stack matrix cell receives only its selected profile credential, plus
Daytona only for Daytona cells. Secret-bearing and OIDC jobs use frozen installs
without a shared dependency cache.
On disposable GitHub Linux runners with Ubuntu's unprivileged-user-namespace
restriction, the authorized default-branch workflow provisions an AppArmor profile before provider credentials are exposed. The profile is attached to the exact
lockfile-pinned Codex executable. It grants `userns` so Codex can construct its
filesystem sandbox; it does not disable the kernel restriction or Codex's
workspace policy. Setup fails before invoking a model if the noninteractive
profile load fails. Target-controlled tests only probe the existing sandbox and never invoke sudo or load host policy. This host-only profile disappears with the ephemeral runner.
See [Ubuntu's namespace restriction documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).
Local developer machines are never modified by this setup. Legacy Codex fixtures
disable optional shell-environment snapshots to avoid persisting credentials;
other suites retain the persisted-state scanner. The `first-task` suite omits
private home/workspace credential-persistence scanning so its evaluation focuses
on onboarding behavior. Artifact redaction and publication scanning remain in
force for every suite.
The Paperclip server process also receives none; the browser posts each value
once to the encrypted company secret API and agents/environments retain only
secret references.

The explicit managed first-task cell observes the wizard's two owned setup
responses only to correlate their exact lease IDs with same-company environment
records. Raw probe/setup responses, account references, opaque provider lease
identities and setup screenshots remain private. Public first-task evidence
continues through the existing projection. Missing or foreign lease identities
cannot acquire attribution or a zero-cost estimate; incomplete setup coverage
stays unavailable even if later task-run billing succeeds. Platform qualification
uses the existing permission-gated environment probe, without granting new
permissions or accepting fixture-authored qualification metadata.

The context-integrity catalog lists six pending Kimi/Grok cells for discovery:
two cases each across `legacy-kimi-cli`, `legacy-kimi-acp`, and `legacy-grok`.
The launcher and direct Playwright runner reject these profiles before loading
credentials. Pi has no qualified model source and is not cataloged. Admission
remains blocked until identity, authentication, skills, session, and billing
evidence is qualified together.

Create `runner-e2e-history`, also default-branch-only, for the OIDC publishing
job. It contains no long-lived AWS key. Required reviewers may be added when a
human approval on every nightly publication is acceptable; otherwise rely on
the actor gate, environment branch restriction, and protected default branch.

## Runner fleet isolation

When `RUNNER_E2E_AWS_ENABLED=true`, paid matrix cells, reusable runner builds,
and Daytona image builds use the exact RunsOn fleet
selector `runs-on/fleet=paperclip-public-pr-x64/env=public-ci`, matching the AWS
fleet selected by `pr-trusted.yml` only after its stable numeric-ID trust gate.
Any other or missing toggle value falls back to the GitHub-hosted
`ubuntu-latest` runner and its lower concurrency ceiling. The workflow chooses
between those two reviewed literal labels; it never evaluates a configured
runner label.

Daytona image builds depend on successful campaign authorization and keep the
existing GHCR publication and signing permissions. They receive no provider
credentials and do not enter the `runner-e2e-paid` environment.

Keep both runner targets restricted to `paperclipai/paperclip` and workflows
that independently authorize trusted source revisions. Never let a fork or
untrusted pull-request workflow target them. The RunsOn fleet must launch a
fresh ephemeral instance for every job, prohibit persistent runner reuse, and
disable interactive SSH/debug access unless a separate incident procedure
explicitly authorizes it.

Changing the runner does not widen who can authorize secret access. The paid
workflow still has only schedule and manual triggers, requires its trusted
definition to come from the protected default branch, requires allowlisted
stable actor IDs before checkout, and repeats that authorization as the first
matrix step. Provider credentials come only from the protected
`runner-e2e-paid` environment. The fleet selector is an exact workflow literal;
the only repository-controlled routing input is its boolean rollout switch, so
configuration cannot redirect a secret-bearing job to an arbitrary runner.

The optional target branch is code, not workflow authority. A CODEOWNER who
dispatches a target branch explicitly authorizes that branch's selected test
process to receive the cell's scoped provider credential. The workflow resolves
the target only inside the same repository, pins one SHA for the campaign, and
checks it out only after authorization. Target-controlled code cannot replace
the report sanitizer or the AWS history publisher. Fork refs and
target-controlled workflow definitions do not enter this path.

## AWS OIDC and S3

The AWS role trust policy should accept only GitHub's OIDC audience and the
publishing environment subject:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:paperclipai/paperclip:environment:runner-e2e-history"
        }
      }
    }
  ]
}
```

Grant only List on the bucket prefix and Get/Put on its objects. Do not grant
Delete, ACL, bucket-policy, or wildcard-resource permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::BUCKET",
      "Condition": {
        "StringLike": { "s3:prefix": ["runner-e2e", "runner-e2e/*"] }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::BUCKET/runner-e2e/*"
    }
  ]
}
```

Enable S3 versioning, default encryption, and Block Public Access. Disable
object ACLs. CloudFront receives read-only access through Origin Access Control;
the bucket itself stays private. Log S3 data writes and alert on attempts to
write outside the prefix or assume the role with a different subject.

Campaign prefixes are content-digested and immutable. The publisher refuses a
different digest at an existing campaign key. Only the compact history and
latest pointers are mutable, and S3 versioning makes those updates recoverable.

## Public evidence boundary

CloudFront and GitHub Pages are public. Fixture identifiers, timing, token
usage, costs, normalized results, and trusted runner PNG screenshots are
expected public data. Each
public screenshot must carry the explicit `public-runner-fixture` marker in
the normalized result. This includes a `failure.png` capture. Screenshot paths
must be safe PNG basenames and must be tied to the exact normalized execution
ID and attempt. The runner capture helper accepts only the exact issue route
for the live fixture that the harness created. Other issue routes, credential
pages, setup pages, and administration pages fail closed. The
CloudFront-backed S3 history also publishes one
synthetic campaign-summary PNG generated by trusted publisher code solely from
fixed catalog labels and sanitized numeric/status fields. Video, archives,
generated Playwright/blob/HTML report trees, SVG or other active content,
credentials, Paperclip homes, databases, workspaces, master keys,
raw/unredacted logs, unmarked images, and unallowlisted files are not public.
Per-attempt JSON snapshots, result copies, logs, Markdown, and text files stay
in the retained Actions artifact. Credential redaction does not remove hidden
reasoning or provider session identities, so a text extension never admits a
file to the public bundle. Graded results remain in `normalized-results.json`.

The normalized result may also contain the reviewed `taskChat` projection:
task titles/briefs, complete saved comments, visible question/approval copy and
recorded answers, agent display names, timestamps, and explicitly classified
native assistant progress. It is captured only from the disposable fixture
company and credential-redacted before retention. Only these presentation
fields are admitted by the closed result validator. Arbitrary interaction
payloads, tool arguments/results, provider/session identities, reasoning and
raw event envelopes are excluded. No per-attempt snapshot or log becomes public
as a consequence. Fixture authors must keep task conversation text public just
as they do the visible content of marked screenshots.

The packaged evidence uploaded as a 30-day GitHub Actions artifact has a
different, broader boundary. Text is exact-value and key-shape scanned and
redacted. PNG and WebM are raw-byte scanned; SVG is rejected during packaging
because it is active content. Raster pixels cannot be exhaustively
secret-scanned by bytes, so fixture authors must treat every marked capture as
public and must never extend the allowed task route to credentials, secrets,
private user data, or other non-public content. Adding or changing a marked
capture requires review of the visible page state. Videos remain
access-controlled.

Before permanent publication, the campaign publisher creates a separate S3
stage and retains only result PNGs with the explicit `public-runner-fixture`
marker under `evidence/`. This applies even to malformed JSON and renamed
process logs. Original packaged evidence and grades remain unchanged.
It then launches publisher-only Chromium with networking blocked to render one
`public-images/campaign-summary.png`. That fixed-path PNG is capped at 12 MiB
and its signature is validated. Per-attempt XML is excluded because browsers
can process XML/XSLT;
the only public XML is the root `junit.xml`, which the report aggregator
constructs from fixed markup and XML-escaped fields. Videos, archives,
raw/unallowlisted logs, SVG, undeclared images, generated reports, and symlinks
fail closed or are removed before the immutable manifest is calculated.

GitHub Pages is built from a second stage without the synthetic summary PNG but
with the same trusted-fixture screenshot allowlist. A leak detected by the
existing packager scan fails the cell and withholds the unsafe file.

Rotate the affected credential immediately if a secret-scanning failure or
unexpected public object is observed. Preserve the access-controlled Actions
artifact and S3 object versions for incident analysis; do not weaken scanning
to make a campaign publish.

`agent-chat-qualification.worker-crash-retry` is local-only and explicit-only.
Linux with Python pidfd support is required; unsupported hosts fail before signalling.
The fault target comes from the public run detail, must be native and running,
and must have an exact `--run-id` command argument. PID 1, the harness PID,
noninteger PIDs, remote profiles, and mismatched identities are refused. The
fixture workspace must be within the disposable instance root. The helper pins an owned pidfd, verifies the exact run argument and recorded
process start ticks again after evidence capture, and signals through that handle.
PID reuse cannot redirect the signal. This is one
specific process signal, never a name-based or machine-wide process kill.
The bounded fixture command is released even on failure; normal instance cleanup
still owns all disposable processes and files. No credentials enter the prompt,
fault metadata, or structured grading fixtures.

### Candidate ACP qualification

The explicit-only `extended-harnesses` launcher removes ambient candidate
admission, then authorizes only selected candidate/model pairs in its isolated
server process. The server never reads admission from agent configuration,
resolved credential bindings, or provider environment. Invalid, duplicate and
mismatched authorization fails closed. Verified packaging and normal company
and tool governance still apply. `CURSOR_AUTH_TOKEN` and
`COPILOT_GITHUB_TOKEN` enter via encrypted company secret references, and all
Cursor, Copilot, GitHub and GH environment variables are stripped from the
server environment. GitHub PAT shapes are included in retained-evidence scans.
Candidates have no automatic infrastructure retries; spending must be reconciled
before a deliberate repeat.

Copilot protection fixtures use production browser/public API permission and
cancellation paths. Their local one-shot socket accepts a nonce/PID only and owns
one fixed bounded child; it cannot select commands, arguments, or paths. The exact
native client command is supplied by the fixture, while production notices retain
only its SHA-256. The fixture keeps private process identities local, closes its
owned socket/child in cleanup, and never signals API-reported PIDs. Directory
watch loss makes the denial oracle incomplete; it must not become a no-effect pass. A run-only Stop without provider dispatch qualifies the denial's
completed-provider branch only when its exact canonical completion was actually
read and retained before Stop. A blocked unfinished task additionally requires
pre-Stop retained missing-result evidence and the exact company/issue/run recovery
binding. Neither exception qualifies definitely-active cancellation, permits
extra runs or mutations, or manufactures a receipt for a historical failure.

Pi Daytona controls bind process identity to the independent Linux observer's
PID, start ticks and boot ID within the exact admitted run/lease/sandbox. The
controller's `processStartedAt` annotations may change as launch metadata settles
and do not identify a remote process birth. Every remote snapshot and retirement
seal must retain the original birth identity and complete no-effect journal.
Local controls retain their separate public process-authority comparison.

Pi provider-death admission accepts the native bootstrap's `/proc/self/fd/3`
or `/proc/self/fd/7` wrapper launch only after binding that held descriptor and
the wrapper executable to the sealed snapshot Node inode. Exact guard and
entrypoint paths, closure hashes, Pi title, run/lease ancestry and fresh process
birth checks remain required. Other descriptor aliases, missing descriptors and
foreign inodes fail before any signal. Native Linux calibration exercises both
descriptor launches with synthetic owned processes and no provider credentials;
it does not qualify paid Pi behavior or change previous failed grades.

The private resource-admission marker and raw cleanup results control recovery-state retention independently of evidence packaging. A worker crash after admission keeps the owner-only recovery database; a confirmed pre-allocation bootstrap failure does not. Neither the marker nor the database enters published evidence.

## Task workspace fixture source

The explicit task-workspaces cells fetch the existing public octocat/Hello-World
repository through normal anonymous repository preparation. They do not clone the
Paperclip checkout, copy its Git credentials, create remote repositories or push.
The agent's synthetic commit remains in the disposable task workspace. Independent
Git reads validate that workspace's canonical path is inside the isolated instance
before examining history. The existing credential redactor, private evidence
packager and task-only screenshot allowlist remain authoritative. Each cell has a
single attempt, three requested turns and company/agent budget hard stops.

The explicit local case-handoff subscription cells accept `CODEX_AUTH_JSON`
only as a private subscription fixture input. The launcher redaction set includes its individual
JSON token values; the server process environment excludes the raw input.
Fixture setup validates a subscription-shaped payload and writes only a new
mode-0600 `auth.json` inside the isolated company's mode-0700 production Codex
home. It rejects redirected roots, API-key payloads and existing login files.
Teardown removes refreshed company login state along with the disposable
instance. Login bytes, account identity, provider sessions and raw native event
payloads are not workflow evidence. The separate API-key receipt cell accepts
`OPENAI_API_KEY` through the ordinary encrypted company-secret fixture and binds
only secret references to both provider key aliases. It neither stages nor
inherits an operator subscription login. The raw key is excluded from child
server environments and public attempt evidence by the existing credential
boundary; do not print it or store it in tracked configuration. The original
arithmetic cell remains subscription-only.

Upstream Codex also records its subscription account ID in `logs_N.sqlite`,
`state_N.sqlite` (thread ownership), and their WAL/SHM companions. The isolated-home persistence scan permits only that
identity value in those exact managed runtime log paths, inside an owner-only
temporary root. It still scans the entire file for every token and other secret;
an identity reused as a credential gets no exception. The private rollout scan
also recognizes only the exact `session_meta.payload.creator_account_id` ownership
field; all instruction/message content and all other fields retain the full scan.
Config, workspaces, unrelated files and all packaged/public evidence retain the
full redaction set. These private databases and rollouts are never copied into evidence and are
removed with the disposable instance. Historical attempts rejected by the older
persistence policy remain failed.

Case screenshots use the exact case ID/identifier returned by that fixture's
public kickoff, in addition to its ordinary task route. Other cases, setup,
settings and external hosts remain outside the public screenshot allowlist.

Receipt smoke uses a fresh isolated company with 100-cent company/agent budgets,
90-second work-run timeouts, low reasoning effort and daily task-run caps of
one/two/one for triage/builder/verifier. Its work contract is exactly four task
runs and one five-minute attempt. Production lifecycle hello probes occur
outside heartbeat counts and budget accounting; up to three initial probes are
expected, and their detailed tokens and cost are unavailable. The flow serializes
readiness, waits at most 45 seconds per agent, fails immediately on lifecycle
error and pauses agents on failure to prevent routine 60-second setup retries.
A timeout does not immediately cancel an in-flight probe. The cell has no absolute
provider inference cap, and its work-run usage report excludes setup probes;
unknown setup usage is not free. The original arithmetic cell keeps its existing settings.
Role routing prompts are appended through the ordinary instruction API after
capturing the production-default bundle. Receipt/review bodies are synthetic
fixture data. Only allowlisted document values, attributed revisions, configured
limits, case/task state and correlated receipt checks enter workflow evidence.
Two passive seed cases support browser list assertions; screenshots remain on
the exact primary case/task routes and document dialogs preserve that case URL.
The public screenshot allowlist is unchanged.

## Eval feedback capture

`snapshots/agent-feedback.json` retains company-wide complaint/suggestion bodies
and attributed invocation outcomes in the access-controlled Actions artifact.
It passes the existing credential scanner and is excluded from public history
like other snapshots. Normalized results and campaign attempt receipts contain
only numeric counts, closed collection statuses, and SHA-256 fingerprints for
review grouping. Public reports never copy feedback bodies, previews, tool
arguments, or free-form collection errors. Collecting feedback performs no new
model call and does not forward it to an external service.

Feedback capture retains at most 1,000 full entries and 8 MiB of serialized
entries/invocations per attempt. Event inspection stops at 10,000 events or
16 MiB of serialized event data. Limits produce partial collection and a closed
`evidence_limit_reached` diagnostic; omitted evidence is never reported as absent.
Checkpoints are considered every ten details, at page boundaries, and at stage
completion; geometric data growth bounds repeated writes. Reads stop before the
overall deadline, reserving up to five seconds (20% of shorter windows) to persist
the collected prefix. Persistence shares the overall collection deadline and
receives an abort signal. The fixture writes an abortable temporary
snapshot before replacing the last complete checkpoint, so a stalled write does
not overwrite earlier evidence with a partially written JSON file.
Review counts and fingerprints advance only after a checkpoint succeeds. A later
write failure or expired deadline retains the last saved bodies and marks coverage
incomplete.

Braintrust export requires an explicit eval project UUID. Native capture includes
prompts, responses, and tool content only after that opt-in configures the isolated
company's observability destination. The ingestion credential crosses the public API via
Node fetch, outside Playwright tracing, and is included in launcher evidence
redaction. Orchestration spans contain identifiers, phase timing, outcome, and
feedback counts; they never contain provider credentials or feedback bodies.

With a bounded operations manifest, the ingestion credential is an expiring
per-attempt relay token. The organization-wide Braintrust key stays in the
controller. Only authenticated POSTs to the relay's trace/log ingest paths are
allowed, with a fixed HTTPS upstream and redirects disabled. Header and payload
`braintrust.parent` values must reference the selected project. Duplicate protobuf
singular/oneof fields are refused, and JSON is canonicalized to remove duplicate
key ambiguity. The token cannot call model, read, delete, or other API endpoints;
it can still write records within the selected project until its finite request,
byte or time allowance is exhausted. It is not an attempt-level row permission.

The worker environment removes upstream provider/Braintrust credentials before
inserting the model and OTLP relay tokens. Ambient relay URLs are discarded, and
the fixture server receives the selected endpoint through company settings.
Both tokens participate in evidence redaction. Private OTLP receipts retain
metadata only, and persistence errors stop further admission. The relay closes
with the model gateway before controller finalization. The controller's direct
finalization export and tracing without an operations manifest retain the
existing direct credential path. Remote relay publication is not enabled here.

The bounded operations manifest is credential-free and private. Its parent-owned
loopback gateway uses an ephemeral per-attempt token. Upstream credentials stay
in the launcher, are included in secret scans, and are removed from the child
provider environment. Only the selected Responses or Messages endpoint is
forwarded to a fixed provider or Braintrust HTTPS origin; request headers do not
select arbitrary destinations. Gateway response caching and fallback are refused.
Request journal and usage receipts contain no prompt/response bodies or keys.
The manifest, journal, and receipts are not public report projections.

`boundedEvalPayload` is the shared, credential-free request validator and
normalizer. Qualification callers must apply it before recording budget-denial
proof. The forwarding path applies the same policy before a ledger reservation.
OpenAI tools may use one namespace level around local function or custom tools.
Function and custom leaves require nonblank string names.
Namespace wrappers contain only `type`, `name`, optional `description`, and
`tools`. Nested namespaces, hosted tools, and tool lists attached to leaves fail
closed. The request may contain at most 1,024 tool definitions, counting namespace
wrappers and their children. Anthropic tool policy stays separate. Output limits,
billing-mode restrictions, and multimodal exclusions apply in both paths.

## Configured repository and conversion proof

The repository proof flow seeds only the exact `workspace` child of its resolved
fixture-owned temporary directory. It initializes that disposable Git checkout
with a fresh random reference. It never modifies a contributor checkout. Provider
credentials remain encrypted fixture secret references. Retention evidence keeps
a digest of allowlisted configuration fields rather than raw environment values.
The public API performs legacy conversion; no database mutation or private
Runner hook performs it. Only synthetic source bytes and proof JSON enter the
existing private attempt evidence and registered-artifact verification pipeline.
A failed attempt remains retained. These development checks are not staging or
Slack qualification, and they do not publish trusted archives or credentials.


Report identities preserve legacy chat tasks and exact `area.case` chat catalog
tasks. Additional task segments, path separators and dotted nonchat tasks remain
invalid. This parsing does not qualify a result or grant a new execution.
