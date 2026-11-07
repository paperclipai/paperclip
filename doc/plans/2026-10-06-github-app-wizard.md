# Minimal dedicated GitHub App wizard

Date: 2026-10-06
Status: Implemented. Automated and local UI qualification in progress; live provider qualification pending.

## Accepted scope

Support personal accounts and organizations equally through a private,
user-owned GitHub App. Its identity belongs to the selected review agent.
GitHub owns the creation confirmation and repository installation consent.
Paperclip owns configuration, credential storage, delivery, and verification.
The normal journey has two Paperclip screens:

1. Choose agent, with an inline low-trust conversion when needed. Assigned
   drafts resume directly into Connect GitHub.
2. Connect GitHub: My account or An organization, optional organization login,
   and an editable name suggested from the agent. Continue submits the manifest
   directly to GitHub. Creation returns securely to Paperclip and then goes
   straight to installation. Installation returns to automatic verification
   and completion, with conditional identity confirmation when necessary.

There is no setup-method selection, delegated setup task, copied prompt,
mandatory guidance form, second repository selection, manual refresh gate,
manual verification gate, or Finish action. Settings retain advanced behavior
and existing-App recovery. Setup-agent assignment remains deferred.

## Defaults and constraints

- Mentions-only, advisory review, linked members, guests off, no merge-rule
  changes. Preserve existing agent instructions and explicit bot configuration.
- Import the installation's initial repository access, including an explicit
  All repositories choice. Preserve saved narrower access on resumed drafts.
  Later additions remain disabled until selected in existing settings.
- Disclose that connecting enables the new bot's GitHub tools. Reconnect
  preserves existing tool restrictions.
- Use GitHub's verified App identity, including renames during registration.
- Keep runtime and isolation readiness separate from GitHub connection health.
  An optional test mention proves execution; connection health alone does not.
- Private Apps install on their owning account. Preserve existing public-App
  connections and manual credential recovery.
- Human-only steps: sign-in/MFA, App creation, repository consent, required org
  administrator approval, initial Cloud enrollment, unverified identity consent.

## Implementation

### Instance

Extend existing manager-only APIs with owner selection, draft persistence,
redacted wizard progress, dedicated-App identity authorization/confirmation,
and automatic completion. Bind callback state and sealed claims to the exact
company, draft, connection, agent, configuring member, and enrolled origin.
Retain the legacy personal registration request and direct webhook flow.

Serialize registration creation against the draft. Retry Cloud creation with
its existing registration identifier and immutable binding after a lost
response. Recover an uncertain manifest exchange or expired claim through the
existing App; never silently create another App. Vault credentials before
acknowledging receipt or exposing installation as the next step.

Use existing verified linked identities when available. Otherwise use the
new App's OAuth flow, separate from its installation callback, with bound
state, PKCE, one explicit identity confirmation, and transient user tokens.
All bot execution continues through installation credentials.

Decrypt original provider webhook bytes from the bounded Cloud gateway queue.
Authenticate their original signature in the stack before entering the existing
durable webhook admission/review path. Preserve resource access,
trust boundaries, revocation handling, and duplicate protection.

### Paperclip Cloud

Use the existing connector broker, durable registry, enrollment, signed
requests, sealed claims, webhook inbox, event leases and acknowledgments, and
coalesced stack wakes as a transport gateway. No per-user tunnel is needed.

The stack builds manifests, exchanges manifest codes directly with GitHub,
vaults every App secret, and owns OAuth state, PKCE, installation verification,
repository access, event interpretation and recovery. Cloud stores opaque routes
and hashes of callback state. It seals callback codes and original webhook bytes
to the enrolled stack before durable storage. It keeps no GitHub private key,
client secret or webhook verifier for dedicated Apps.

Cloud provides separate public manifest/install/OAuth callback URLs. Installation
parameters never prove ownership. The stack authenticates the original webhook
signature. Cloud applies bounded ingress, queue and wake limits to unverified
traffic. Deduplication includes the original body and signature to prevent forged
delivery identifiers from suppressing valid events.

The additive capability is available by default with the Cloud connector broker
and advertises version 2; no separate enable flag is required. Deploy the additive
Cloud migration and gateway before
the synchronized instance wizard. Existing shared-App account connections keep
their provider-specific broker behavior and secret-store requirements.

## Qualification

Automated coverage must exercise both owner URLs; private manifests; bound
callbacks and claims; retries after lost responses; failed and expired
exchanges without duplicate Apps; hostile signatures/owner bindings;
duplicate deliveries; preserved configuration and repository restrictions;
identity consent/expiry; company isolation; and legacy registration/recovery.

Run focused backend/UI tests and token gates, then typecheck, Vitest, and
build. Walk through the actual local UI for agent selection, account choice,
save/resume, enrollment and recovery. Separately qualify real personal and
organization App creation/installation and a response under each dedicated
identity, with human consent. Mocked provider tests cannot establish that live
qualification or runtime execution succeeded.

## Evidence and remaining rollout gates

The production wizard was exercised in an isolated local test drive. Agent
selection, inline low-trust conversion, organization choice, name editing,
Save & exit, resume without a reload, full reload, and the conditional Cloud
enrollment handoff passed. The test did not authorize Cloud enrollment or
create a provider App.

The focused wizard and retained clipboard/recovery UI suites pass (37 tests).
GitHub backend coverage passes (193 cases), including both owner types,
interrupted registration and vault storage, empty saved repository selections,
localhost configuration, concurrent identity attempts, enrolled-origin recovery,
tenant binding, and legacy callbacks. The complete OpenAPI suite passes (13
tests). Workspace typecheck, build, and UI token gates pass. The revised GitHub
browser journey passes through manual recovery, identity confirmation, automatic
completion, settings, and reconnect.

The full local Vitest run reported 16,080 passing tests, nine failing tests,
and three suites with database-startup timeouts. All ten failing suites passed
in isolation (303 tests). The original full run remains a failed run; it is not
a claim of a green full suite. CI initially
identified outdated wizard expectations and missing API documentation, both now
covered by the updated focused checks. The full GitHub fixture also verifies
installation permissions and preserved legacy tool authority. The browser
report attaches screenshots of both wizard screens. Fresh manual App imports
initialize repository access and tools without a registration row; interrupted
imports resume those defaults while explicit restrictions stay preserved. A real
vault-write interruption stays in recovery without completing an empty import;
retrying the credentials discovers and imports the actual repositories.

The earlier Cloud qualification tested a Cloud-owned App lifecycle. The
2026-10-07 architecture revision replaces that lifecycle with the gateway
boundary described above. Its standard `npm test` passes: 2,552 tests and 73
conditional skips. Gateway regressions verify sealed callback and webhook
storage, route/tenant binding, removed instances, renamed origins, forged
identifier suppression, lease/acknowledgment and queue limits. Cloud typecheck
and routing/sleep/wake smoke checks pass.

The revised stack passes workspace typecheck and build. Focused tests cover
local manifest exchange, interrupted vault storage without repeated exchange,
secret rotation without disclosing it to Cloud, original-signature verification,
and nested-envelope binding. Initial follow-up database attempts were blocked by
exhausted host shared-memory identifiers (`shmget`: No space left on device).
After slots became available, disposable Cloud Postgres qualification passed all
seven tests, including independent-pool quota races and lease/acknowledgment.
The focused stack cases also execute again; the added recovery case requires all
manifest credentials, including OAuth client credentials, after a partial vault
write. Explicit existing-App recovery switches to the supported personal-connection
identity path only after the same App's credentials are vaulted; it still repairs
the webhook locally and requires fresh signed delivery. Member account-only
linking avoids manager setup APIs and retains personal-connection onboarding.
The final focused wizard/recovery/member-linking tests pass (26), as do server
and UI typecheck/build and token gates. Full-suite local failures remain separately
reported rather than treated
as a green run. The current PR heads require fresh CI and review. No real
provider calls or deployments were used for this revision.

Before rollout, apply the additive Cloud migration and deploy the gateway,
then deploy the synchronized instance migration and wizard through
the existing connector rollout control. A real personal and organization
registration, installation, consent, signed delivery and bot response remain
required. No deployment, real App creation, installation, runtime provisioning,
or model execution was performed by the local UI walkthrough.

## Deferred follow-up: production push delivery (2026-10-08)

Use push as the primary Cloud gateway-to-stack transport in production so new
mentions, issues, and PR events arrive promptly. Wake sleeping hosted stacks
when needed. Keep polling as a recovery and catch-up path for missed pushes,
disconnects, and restarts, rather than the normal production delivery path.

Retain the durable inbox, delivery acknowledgments, tenant bindings, original
GitHub signature verification, and deduplication across push and polling.
Localhost and self-hosted instances can continue using outbound polling.
This is a deferred improvement; do not implement it in the current setup work.

## Live setup finding: slow repository verification (2026-10-08)

The personal-account Animal Bot Man setup received a verified signed ping at
10:31:10 UTC. Its wizard still showed the previous ping-wait response while
connection verification checked 86 enabled repositories, once in progress and
again under the credential lease before activation. The next setup response
completed at 10:32:03 UTC; missing HTTPS was not the cause.

Verify explicit enabled repository IDs in batches within GitHub's 500-ID limit,
preserving the final check under the activation lease. Never request an unscoped
token or pass these verification tokens to agents. A failed batch remains
unverified. As soon as endpoint polling observes signed delivery, replace the
old ping-wait message with App/repository verification progress. Keep the same
App, vault, agent, and GitHub-selected repository access.

Focused tests cover 86- and 501-repository verification, disabled selections,
revoked access, and the UI receipt arriving ahead of a full progress response.
The existing draft reached connected without a new App or credential entry.
After restarting the preserved test drive with the fix, this same App's full
progress verification returned connected in 2.74 seconds, with all 86 repository
checks passing and the configuration still at revision 1. Server/UI typecheck
and builds, 24 focused backend tests, 19 wizard UI tests, and token gates pass.
Connection completion remains separate from proving a model or review run.

[GitHub's installation-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
specifies the 500-repository limit and prohibits granting access beyond the
installation's authorized repositories.

## Prior findings retained

Earlier setup research found repeated interviews, missing manager APIs, tunnel
requirements, runtime provisioning, and image-delivery limitations. This wizard supersedes
its onboarding approach. Setup agents, runtime provisioning, and screenshot
publication are deferred; GitHub connection completion must not claim any of
those are working.

## Provider references

- [Manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [App registration and ownership](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)
- [Setup callback verification](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
