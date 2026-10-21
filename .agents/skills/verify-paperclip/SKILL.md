---
name: verify-paperclip
description: Verify Paperclip from a source checkout, published npm install, or existing staging or production stack. Select the environment, data state, version, and platform; drive real UI or CLI journeys and capture evidence. Route deployment to the private Cloud skills.
---

# Verify Paperclip

Read the [map contract](../../../maps/README.md), then use the
[feature map](../../../maps/feature-map/README.md) to select user verification
recipes. For API/agent access, read the same-named
[agent access companion](../../../maps/agent-access-map/README.md) and use the
actual permitted agent identity, target and work mode. Follow existing API/runner/MCP
fixtures for access proof; a board request does not prove agent access. Report
recipe or access drift with evidence; map updates belong to
[maintain-verification-skill](../maintain-verification-skill/SKILL.md).
Read [development instructions](../../../doc/DEVELOPING.md) for current commands.

## Select the verification target

State what is being tested before starting. Use the requested target; for ordinary
feature development, default to the current checkout on the current host with
isolated data. Expand into cross-platform or release qualification only when
requested or needed to reproduce the problem.

Record these independent dimensions together:

- **Artifact:** source checkout (path, commit, dirty state), published npm package
  (requested channel and resolved exact version), or deployed image/release.
- **Environment:** local, staging, or production; target URL and intended company
  or workspace; board/user/agent identity and authentication mode.
- **Starting data:** fresh and unonboarded, freshly seeded, cloned, or reused;
  embedded versus external PostgreSQL; configuration/data location or a redacted
  database identifier. Never record credentials or connection strings.
- **Platform:** server OS/architecture, Node/npm versions, and browser/client OS
  when relevant. A Mac browser against a Linux server is Linux server evidence;
  WSL is Linux evidence, not native Windows evidence.
- **Journey:** first installation/onboarding, an existing-user feature, upgrade,
  or a live agent run; expected outcome and real versus simulated dependencies.

| Target | Use it to prove | Procedure |
| --- | --- | --- |
| Checkout dev server, existing or cloned data | Source behavior against existing state | [Checkout modes](references/verification-targets.md#checkout-and-data-modes) |
| Checkout with fresh empty data | First-run onboarding and subsequent features | [Launch](#launch-an-empty-checkout-instance) below |
| Checkout test drive, fresh seed or reused data | Features with a configured company/CEO | [Checkout modes](references/verification-targets.md#checkout-and-data-modes) |
| Published npm canary | End-user installation of a specific prerelease | [npm verification](references/npm-install.md) |
| Published npm stable (`latest`) | End-user installation of the released package | [npm verification](references/npm-install.md) |
| Existing staging stack | Deployed build, hosted auth, flags, integrations | [Hosted verification](references/verification-targets.md#staging-and-production) |
| Existing production stack | Current production journey within the authorized scope | [Hosted verification](references/verification-targets.md#staging-and-production) |

Fresh data does not imply a fresh install. A seeded test drive does not prove
onboarding. A source build does not prove npm packaging. A passing staging check
does not prove production, and a production Cloud stack does not prove the stable
npm install. Report only the combinations actually exercised.

## Deployment handoff

When a requested revision must first be built or deployed, use the skills in the
private `paperclip-cloud` repo:

- `deploy-paperclip-stack` at `.agents/skills/deploy-paperclip-stack/SKILL.md`
  for a tenant workspace or an explicitly scoped fleet rollout.
- `deploy-cloud-harness` at `.agents/skills/deploy-cloud-harness/SKILL.md`
  for the Cloud control plane itself.

Locate the authorized Cloud checkout or installed skill by name; do not assume a
sibling directory exists. Those skills own build preparation, deployment,
migrations, and rollout recovery. Return here with environment, target, resolved
source SHA, release/image identity, deployment result, and evidence link. If
private access is unavailable, report that prerequisite as blocked and continue
checks possible on the supplied target without inventing deploy commands.

A verification request alone does not authorize deployment, npm publication,
fleet-default changes, or a production rollout. Preserve explicit deployment
instructions already given. Publishing npm packages belongs to the existing
[release skill](../release/SKILL.md); installing one does not require publishing it.

## Launch an empty checkout instance

Run from the repository root with Node 24.11+, Python 3, `lsof`, and dependencies
installed with `pnpm install --frozen-lockfile`. Browser driving uses the existing
`@playwright/test` dependency. If Chromium is unavailable, run
`node node_modules/@playwright/test/cli.js install chromium`, or select an installed
browser with `PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome`.

Create separate, unique data and evidence directories. Keep the evidence outside
the data directory:

```sh
VERIFY_DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/paperclip-verify-XXXXXX")
VERIFY_EVIDENCE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/paperclip-proof-XXXXXX")
python3 .agents/skills/verify-paperclip/scripts/launch.py \
  --data-dir "$VERIFY_DATA_DIR" --evidence-dir "$VERIFY_EVIDENCE_DIR"
```

Keep this command in a foreground terminal/session. The helper runs the supported
`onboard --yes --bind loopback --no-install-service --run` command, with isolated
embedded PostgreSQL, a free loopback port, no inherited instance routing or cwd
`.env`, and no automatic browser opening. It records `launch.json` in the evidence
directory. Source startup builds its required shared/plugin packages and migrates
the empty database; readiness can take longer on the first run.

This path starts an empty instance without model credentials. Create company and
agent state through the journey being checked. A UI check that stops before model
execution does not prove an agent run. For a preconfigured company/CEO and live
model work, use the documented [test-drive](../../../doc/DEVELOPING.md#one-command-isolated-manual-test-drive)
command with an authorized environment-backed credential and `--no-browser`.
Record its printed data directory, URL, runtime PID and commit before driving;
never use a fake credential to claim provider verification.

For Paperclip-managed reusable services, follow
[dev-workspace run/verify/fix](../paperclip-dev-workspace-run-verify-fix/SKILL.md)
instead of launching a second server. Its cloned-data/login requirements differ
from this empty local instance.

## Doctor (owned checkout helper only)

The doctor/stop commands require the real `launch.json` created by `launch.py`.
Do not fabricate one for dev servers, npm installs, test drives, or hosted stacks.
Use their own readiness and lifecycle procedures instead.

After startup, and again after any surprising behavior, run:

```sh
python3 .agents/skills/verify-paperclip/scripts/doctor.py \
  --evidence-dir "$VERIFY_EVIDENCE_DIR"
```

This read-only check compares the recorded launcher, runtime PID, port owner,
process cwd, configuration, served Git commit, health/bootstrap readiness, root
HTML response, and company-list access. It writes `doctor.json` or exits nonzero.
Do not trust a root 200 or CLI doctor output alone. The CLI doctor checks whether
the port is available before startup; it is not proof of a running server's
ownership. Browser readiness still requires the expected visible page. Reset or
relaunch a wedged browser even when the process health passes.

## Drive

Use accessible roles, labels, and placeholders from the latest page state.
Existing Playwright specs in `tests/e2e/` supply recipes and selectors; their
configured servers and fixtures are separate from this live instance. Run a named
suite through its own configuration only when that is the evidence needed.

The executable onboarding smoke drives `onboarding.md` / `web-wizard`: open
`/onboarding` in the disposable self-hosted instance,
enter a unique organization name, choose Continue, reach the agent-name field,
reopen `/<company-prefix>/onboarding`, reload, and corroborate the saved company
through read-only API checks:

```sh
node .agents/skills/verify-paperclip/scripts/onboarding-smoke.mjs \
  --evidence-dir "$VERIFY_EVIDENCE_DIR"
```

This covers company creation and setup resumption, with no mocked responses or
provider calls. Hiring, first task execution, and the alternate CLI entry remain
separate journeys. The script requires an empty instance and refuses a non-owned
or non-loopback target. For other features, reuse the owned URL and follow the
map's entry points. Company routes normally require the selected company's
`issuePrefix`, for example `/<PREFIX>/goals`; use current navigation rather than
guessing resource URLs. The unprefixed `/onboarding` route starts naming; use the
company-prefixed onboarding route to resume its agent setup. Check relevant
experimental gates and actor permissions.

For source-checkout CLI checks, discover exact flags with
`node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> --help`, then
select the disposable data directory/API/company explicitly. For published npm
checks, use the installed version’s CLI and help instead. API reads can
corroborate UI writes; API-created state does not prove a creation UI.

## Evidence

Include the target dimensions above, then record feature file, sub-feature and
entry-point ID, commit/dirty state, target URL,
company/user, flags, runtime/harness, live versus simulated dependencies, command,
exit code, expected and observed behavior, and evidence links. Report each entry
as passed, failed, blocked with its prerequisite, or not run.

The smoke saves before/after/reload screenshots, visible-page text, a Playwright
trace, and `result.json` with company ID and API corroboration. On failure it
retains the trace, visible state, and failure result; rerun doctor before retrying.
Preserve launch output and relevant application logs without secrets. Reopen or
reload changed state and verify persistence/continuation, not just a success toast.
One passing sub-feature does not certify the entire feature family or other
surfaces. A full maintenance pass must exercise every mapped feature or report
incomplete coverage.

For Paperclip-assigned work, attach important proof through
[the artifact workflow](../../../doc/AGENT-ARTIFACTS.md). Keep runtime results in
the evidence directory or issue, not in the map. The generated
`maps/generated/coverage.json` lists page references, not live test health.

### Preserve failures through acceptance

A successful retry establishes that a later attempt succeeded. Retain earlier
material failures in the verification record, including the failed requirement,
relevant logs, and what changed before the retry. Use a focused comparison or
reproduction to determine whether the change caused the failure. When useful,
check the unchanged baseline under comparable conditions. If the cause remains
unknown, state that uncertainty; do not infer an infrastructure fault from a
passing retry alone.

Report recovery and resolution separately. A later passing journey can show
recovery without explaining the earlier failure. Do not describe acceptance as
complete while a relevant requirement remains unverified. Record the remaining
gap and the next discriminating check instead of repeating retries until green.

Apply this to failures that bear on the changed behavior or requested acceptance
criteria. Independently established infrastructure failures can be tracked
separately, with supporting evidence and any checks they prevented still marked
blocked or not run. This does not require investigating every unrelated failure.

## Cleanup

Close the browser context you created (the smoke does this in `finally`). Leave
shared dev, staging, and production services running. The remaining cleanup steps
in this section apply only to `launch.py` instances; use the selected target’s
procedure for other launchers. Stop the helper-owned runtime with:

```sh
python3 .agents/skills/verify-paperclip/scripts/stop.py \
  --evidence-dir "$VERIFY_EVIDENCE_DIR"
```

The helper verifies the runtime's port, cwd, and launch ancestry before sending
SIGTERM to that PID, then waits for runtime exit and checks that its HTTP
listener and embedded database have stopped. Signaling the runtime PID lets the server drain before stopping
PostgreSQL; a terminal group interrupt can reach the database first. Do this after
failed drives as well as successful runs. If startup fails before a runtime record
exists, stop only the foreground session you created and inspect its recorded data
directory for residue. Never kill by process name or stop another checkout's server.

Verify the recorded HTTP port has no listener and the owned runtime PID has
exited. Embedded PostgreSQL should stop with the server; inspect only the recorded
data directory if shutdown is incomplete. Retain the data directory for diagnosis
until no owned process uses it; remove only that exact temporary directory when
it is no longer useful. Never delete the evidence directory during teardown.
Confirm screenshots, trace, `result.json`, `launch.json`, and `doctor.json` still
exist after shutdown. A failed launch leaves its evidence intact.

## Helpers

All helper invocations are shown above. `launch.py`, `doctor.py`, and `stop.py` use Python's
standard library and the repo CLI; `onboarding-smoke.mjs` uses the repo's existing
Playwright dependency. They introduce no new package dependency or test framework.

## Helper safety check

Run the standard-library ownership test before changing launch/doctor/stop helpers:

```sh
python3 -m unittest discover -s .agents/skills/verify-paperclip/tests -v
```

It starts an owned fixture in another temporary checkout and confirms that both
doctor and stop reject its claimed port/PID without stopping the server. A second
fixture closes its listener before exiting and proves that cleanup waits for
runtime exit. These checks do
not qualify Paperclip startup, database readiness, or onboarding.
