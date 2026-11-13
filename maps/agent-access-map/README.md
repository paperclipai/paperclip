# Paperclip agent access map

This map accompanies the [feature map](../feature-map/README.md). It records APIs,
agent entry points, permission boundaries and verification for the same capability IDs.
The [shared contract](../README.md) defines the format and maintenance rules.

The [chat scenario catalog](../../tests/runner-e2e/chat-scenarios/README.md) uses
these same IDs for human requests and expected outcomes. Its scenarios retain
the access boundaries here; neither a CEO role nor a planned scenario grants
board authority or establishes a working production tool binding.

Use full capability IDs when referring to access contracts outside their file:
`onboarding/company` means the `company` capability in `onboarding.md` in both maps.
The [feature index](../feature-map/README.md#browse-features) lists feature and
capability IDs; [IDs and references](../feature-map/README.md#ids-and-references)
explains entry-point references and stable naming.

## Browse access contracts

The same-named feature recipes define navigation and capability IDs. Run
`node scripts/storybook-catalog.mjs` for the generated
`maps/generated/agent-access-map.md` index, or browse the
[published feature guide](https://d1p6rlowie26tp.cloudfront.net/storybook/branches/master/?path=/story/overview-storybook-guide--coverage-guide).
Add or update the affected companion; there is no central registration or count.

Existing baseline source references describe the original inspection, not current
verification. Record new executed evidence in the PR, issue, or CI artifact with
its revision and scope. Do not refresh unrelated headers as bookkeeping.

## Using an entry

Read its Policy and Gaps before selecting an agent path. Native fallback, legacy
REST/CLI, stdio MCP and a personal assistant connection can have different
authority and availability. Use a real admitted production binding; a scenario
declaration is not an installed tool. A `restricted` entry records current
enforcement and leaves any unresolved delegation decision visible.

For API catalog disagreements, follow the route/service authorization and record
discovery drift. For `not-applicable`, retain the concrete exception and local
path. Split shared business operations from client-only presentation.

Use `maintain-verification-skill` to reconcile changed source and both maps.
Use `verify-paperclip` and existing API/runner/MCP fixtures to collect the
permitted-agent and denial evidence; report blocked/not-run coverage honestly.
Run `node scripts/check-maps.mjs` after editing. The structural check does not
certify permissions, API catalog coverage, tool admission or live behavior.

## Native REST transport

The `call_api` parity change reconciles affected baselines against
`58e16dbddfc9c8d0cf60867f9d9847f0feda055b` and the changes in this PR. Ordinary
REST operations use the same route authorization as legacy agent REST. Dedicated
tools remain optional for those operations; protocol endpoints still need their
existing clients. Board-only routes remain restricted for agent identity.

Native `search_api` / `call_api` is enabled by default, but explicit server,
company-allowlist and binding settings can narrow admission. It requires a running
authorized native run, current task assignment and execution-run binding, company
and budget authority, task privacy, and a permitted work mode. Ask and Plan retain
mutation restrictions, and runs retain their admitted JWT scope during restart
recovery even when task mode changes. A waiting
agent does not gain independent native control just because a REST route exists.
Connection-management reads support Standard, Ask and Plan; mutations require
Standard. Skill-test runs and nonstandard task-bridge keys cannot administer
connections. These gates supplement each operation's grants, resolved resource
and target scope, and responsible-user authority. See the
[rollout policy](../../server/src/services/native-runtime/runner-api-rollout.ts)
and [connection authorization](../../server/src/services/connection-management.ts).

Credential-bearing replies, including company exports and their legacy alias,
stay inline under a 10 MiB limit and use encrypted mutation receipts. Other saved
API snapshots are limited to the issuing actor and responsible user, plus authorized
administrators. Artifact uploads enforce the same access checks as downloads;
private snapshots are excluded from company exports and public company logos.
Explicit deliverables use the existing sharing path. Native event history,
checkpoints and completion records omit API bodies while preserving receipt
metadata and replay digests. Restored webhook secrets use the same encrypted
receipt and inline response policy as newly created webhook secrets.
Task image access requires the company boundary and the task permission;
skill-test and low-trust agents do not need company-wide browsing authority.
Completion replay applies the same idempotent projection to stored and expected
payloads; [the run-log guide](../../doc/run-log-events.md) describes its fields.

Sources: [API client](../../server/src/services/native-runtime/runner-api-client.ts),
[catalog](../../server/src/services/native-runtime/runner-api-catalog.ts),
[native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts),
[credential storage classification](../../server/src/services/native-runtime/runner-api-sensitive-response.ts),
[snapshot access](../../server/src/services/asset-content-access.ts),
and [history redaction](../../server/src/services/native-runtime/runner-api-log-redaction.ts). The affected entries remain
`baseline` and `source-only`; this reconciliation does not certify every operation.
Targeted real-route proof lives in the
[API integration suite](../../server/src/services/native-runtime/runner-api.integration.test.ts),
including owned routines, skill tests, scoped secrets, proposals and private export replay.
