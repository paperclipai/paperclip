# Railway implementation verification

Updated: 2026-09-16. Implementation and local verification were performed on
2026-09-13. The change is published for review on a dedicated branch.
Live qualification remains open. Full GitHub CI passed on commit `303340f19`
before the source-deployment security follow-up below.

## Thinking Path

> - Paperclip controls the access that agents receive to external resources.
> - Apps already supplies remote MCP, OAuth, vault storage, grants and policies.
> - Operators need Railway service inspection, logs, deployments and container commands.
> - The hosted Railway server alone does not supply narrow governed tools for all these operations.
> - This change adds a branded connector and fixed direct operations inside the existing gateway.
> - Dedicated grant keys enable bounded commands in deployed containers.
> - Operators keep the existing action defaults and can require approval before execution.

## Linked Issues or Issue Description

**Subsystem affected**

Apps catalog, connection setup, gateway execution, shared contracts and connection documentation.

**Problem or motivation**

An operator needs to authorize a Railway account once, grant access to selected
agents, and let them inspect and operate Railway resources through Paperclip.

**Proposed solution**

Use hosted OAuth for connection setup. Expose direct status/log/deployment tools
only after an actual API credential probe. Add separate container-key setup and
a fixed OpenSSH runner behind the same grant and policy checks.

**Alternatives considered**

A manifest alone cannot execute missing operational tools. The hosted general
agent has opaque internal effects. An unrestricted CLI runtime would bypass
per-action review and could inherit ambient credentials.

## What Changed

- Added Railway's generated definition, curated entry, official marks and provenance.
- Added fixed GraphQL operations for service/deployment status, bounded logs,
  and redeploy/restart/rollback. Source deployment is blocked pending atomic
  provider repository/revision binding.
- Added grant-owned SSH key setup and container commands with host verification,
  target checks, deadlines, output caps and cleanup.
- Blocked the hosted general agent and staged-change acceptance. Preserved normal
  Allowed defaults and Ask-first policies. Kept changed-schema quarantine across reconnect.
- Added setup guidance, provider fixtures, lifecycle/SSH/gateway tests and browser verification.

## Verification

Security follow-up on 2026-09-16: removed the source-deployment schema and mutation.
The provider block applies to old active catalog entries and normalized aliases
before refresh; refresh marks them disabled. Regression tests cover direct-client
and gateway denial before any upstream request. A repository preflight is no
longer used as authorization for source deployment.
All 386 focused Railway, catalog and gateway tests passed for this follow-up.

After rebase onto master on 2026-09-14, 440 focused provider, connection, gateway,
catalog and container-panel tests passed. The AppDetail and AppsConnect suites
passed another 196 tests. The new Apps entries on master are preserved.

Passing checks observed during the original implementation:

- 284 tests across the final Railway API, SSH, lifecycle, tool-access service and shared-definition suites.
- 59 generic-MCP tests. These cover callback/state/issuer binding and OAuth error paths.
- 62 gateway tests and 3 container-panel tests.
- AppDetail and AppsConnect UI suites passed as part of a 224-test targeted run.
- The browser test `tests/e2e/railway-catalog.spec.ts` passed against a throwaway
  instance. It checks the real gallery, logo, OAuth setup entry and visible limitations.
  It does not complete Railway account consent.
- `pnpm -r typecheck`, `pnpm build`, and `pnpm check:token-gates` passed.
- Local port 3100 serves the dev checkout, health reports `ok`, bootstrap is ready,
  the Railway brand asset returns 200, and the public OAuth metadata advertises
  the loopback callback. An unauthenticated browser reaches the sign-in page.

The full `pnpm test:run` attempt was stopped after failures outside the focused
Railway coverage and repeated database-startup timeouts. One related gallery
count expectation was fixed and the complete tool-access suite subsequently
passed. Other failures included five chat integration timeouts, three company
skills cases, native session-resume fixtures, and the CLI guidance scan finding
an existing local `.claude/settings.local.json` command. Native and CLI failures
were reproduced separately; no unrelated source or private settings were changed.
The full suite is **not green**, and later runner shards did not complete.

The pinned Rust 1.97.1 toolchain was used for full typecheck/build. Browser
output and detailed logs are retained locally as ignored QA output. No provider
credentials, private configuration, or unsanitized live captures are committed.

Follow-up after the operator connected locally: loopback consent and actual
tools/list succeeded. The initial direct API probe incorrectly requested projects
without a workspace ID. Railway returned HTTP 200 with a `Not Authorized` GraphQL
error; the same token accepted a query bound to the selected workspace. The fix
discovers a workspace through the hosted read, requires a workspace ID for direct
project listing, and recognizes GraphQL authorization errors without exposing
provider details or requesting broader OAuth scopes.

The repaired local connection reports direct API access available. Its 44 hosted
actions remain active; the 12 newly discovered direct actions remain quarantined
for review. Direct project, service and environment reads succeeded; the inspected
project has no services. No deployment or container operation was attempted.
The follow-up Railway suites passed 30 tests, the shared tool-access/gateway suites
passed 293 tests, and server TypeScript checking passed.
The live evidence contains only status and resource counts; it remains local.

Agent gateway proof, disposable service/deployment targets, HTTPS/customer-client
registration, logs, deployment, SSH enrollment/host trust, refresh and provider
cleanup still require operator-assisted proof. See
[RAILWAY.md](RAILWAY.md) for the exact release checklist and setup.

## Risks

- Live provider qualification remains outstanding. Advertised DCR is not proof
  that a particular account/client/callback combination works.
- OAuth authorization can cover more resources than one service. Metadata filters
  are not local authorization allowlists.
- Container commands have broad internal authority; timeout cannot guarantee remote
  child termination. Provider-side key removal is a separate operator action.
- Source deployment is unavailable until the provider can atomically bind the
  approved repository and commit. Existing deployments can still be redeployed,
  restarted or rolled back.
- No schema migration is needed. Rollback can remove promotion and direct dispatch
  while retaining connection data and the generic MCP path.
- The full test suite must be resolved before claiming release readiness.

## Model Used

OpenAI Codex, based on GPT-6, with tool execution and a separate read-only security
review agent. The exact serving deployment ID and context window were not exposed
in this session. The independent reviewer found no remaining concrete blocker
for a local preview; this is not a claim of completed live qualification.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used, with available version and capability details
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have described the issue using the feature-request fields
- [x] I have not referenced internal Paperclip issues
- [x] My branch name describes the change
- [ ] I have run all tests locally and they pass
- [x] I have added or updated relevant tests
- [x] I have updated the connection documentation
- [x] I have documented the risks
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open follow-ups
- [x] I will address all reviewer comments before requesting merge

Unchecked release checks remain pending. Related Railway PRs #311, #939 and
#7861 concern hosting Paperclip on Railway, not governing Railway through Apps.
This implementation uses the existing governed Apps path described in ROADMAP.md.
