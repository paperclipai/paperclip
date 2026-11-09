# External-bot conformance and qualification

## Contents

- [Keep the evidence levels explicit](#keep-the-evidence-levels-explicit)
- [Minimum real-provider journeys](#minimum-real-provider-journeys)
- [Select additional rows from the capability contract](#select-additional-rows-from-the-capability-contract)
- [Record evidence that survives a handoff](#record-evidence-that-survives-a-handoff)
- [Historical Paperclip test entry point](#historical-paperclip-test-entry-point)

## Keep the evidence levels explicit

| Level | What it proves | What it does not prove |
| --- | --- | --- |
| Unit / contract tests | Schema, policy, state transitions, selected races | Real provider or deployed routing |
| Scripted client + actual Rust/DB | End-to-end protocol and ordinary tool/finalizer integration | Provider tool loading, wake behavior, browser setup |
| Scripted client + managed sandbox | Remote artifact/transport, placement, cleanup | Actual external bot or Cloud tenant ingress |
| Actual bot + test drive | Provider behavior, real event/tool loop | Published app image or fresh tenant behavior |
| Actual bot + deployed tenant | Named deployed candidate and selected journeys | All accounts, long-duration reliability, public distribution |

For UI, a Storybook fixture proves a rendered state, not that the backend reaches
that state. A deep link that bypasses onboarding does not prove discoverability.

Use the current repo's `paperclip-evals`, `add-runner-eval`, and
`add-product-e2e-eval` procedures when relevant and available. Locate an existing
case before adding a new fixture. The recipes below specify outcomes; adapt their
tool calls to the actual provider. Do not infer live success from this document.

## Minimum real-provider journeys

### C01 — first connection from a fresh invitation

Start with a synthetic company and no binding for the new agent. Enter through
ordinary agent creation, not its runtime deep link. Generate the prompt and give
it to the real bot. Use only the human actions agreed in the release contract.

Require all of: correct scoped grant, actual read tool invocation, verified
subscription, correlated readiness challenge acknowledged, binding persisted,
agent ready, UI Done, and state still correct after refresh. Do not create a work
task or allocate a sandbox for the readiness challenge. Save the action log and
final screenshot. Record app attachment, reboot, manual consent, or inbox nudges
as interventions. A repaired setup can pass functionally while failing first-try UX.

### C02 — Paperclip assigns useful work with no chat nudge

Create an ordinary task with a fresh synthetic nonce. Example:

```text
Calculate 17 + 25. Write a task document named integration-proof containing
“17 + 25 = 42” and the nonce <RANDOM_NONCE>. Read it back and finish using the
assignment's completion contract. Use no workspace or attachment access.
```

Assign through the normal UI/API and wait for the supported event path. Verify
explicit acceptance, agent/run attribution, document contents and revision count,
canonical completion receipt, run success, task disposition, and cleanup. A
nonce-specific artifact proves the correct task was processed. Do not submit its
result through a connector yourself and describe that as the bot's execution.

### C03 — bot initiates work while idle

With no active assignment, tell the real bot:

```text
Create a Paperclip task titled <UNIQUE_TITLE> and assign it to my responsible
human owner. Find that person using the connection's identity/people tools.
Start governed work yourself if necessary, then return the created task link.
```

Require one visible bot-authored intake, ordinary admission, actual human assignee,
one created target task, and intake completion. Repeat the intake request with the
same stable request ID before and after completion: no additional task/run. A
different prompt with the same ID must fail. Simulate admission failure: the bot
gets an actionable terminal result rather than waiting forever for an offer.

### C04 — use native capabilities and bring back the result

Use a user-authorized synthetic source in a native tool already connected to the
bot, deliberately absent from the Paperclip assigned-app catalog. Ask a question
whose answer requires that source. Require the actual native read and a useful
result persisted on the Paperclip task. Keep data/destination authority explicit;
do not create a new third-party grant solely to make this test pass.

Run once after a narrowly scoped qualification test ends. Failure if the bot says
it lacks the tool merely because Paperclip does not list it. Also verify the
bot cannot substitute another Paperclip identity to bypass a denied operation.

### C05 — follow-up plus a real controller restart

Have the bot accept a task and report readiness once, then wait for a normal task
comment. Capture run/assignment/session, sandbox lease, Runner marker/PID/birth
fingerprint, and controller identity. Restart the owned controller and verify
that it actually changed. Wait through a realistic bounded reconnect gap.

Post the resume instruction as an ordinary Paperclip comment. Require the same
assignment/session/Runner, read of that exact comment, one document result, one
finalization, one task run, and released resources. A dev supervisor that kept
the controller alive invalidates the experiment. A new run completing the task
is retry evidence, not recovery evidence.

Separately force the comment to arrive at completion: unread comments survive
for the next turn; comments read by the active assignment do not run twice.

### C06 — stop and revoked authority

Cancel a synthetic active assignment, then attempt an effect using its old
authority. Verify rejection, fence delivery/acknowledgment, terminal run/assignment
reconciliation, and resource release. Repeat protocol tests for pause, reassignment,
membership loss, revoked grant, refresh replay, and budget stop as applicable.
Do not report global provider termination without provider-level evidence.

## Select additional rows from the capability contract

| ID / boundary | Stimulus | Required observation |
| --- | --- | --- |
| O01 pending renewal | Expire code while dialog open; reopen after refresh | Fresh usable prompt, same agent, no error-as-normal-flow. |
| O02 race | Pair while another tab renews | Completed binding preserved; no two active grants or renewal loop. |
| O03 lifecycle | Preparing, verifying, manually paused, awaiting approval | Setup allowed only in legitimate setup states; Done waits for readiness. |
| O04 provider runtime | Install/update plugin while bot conversation active | Actual new action usable; catalog refresh/attachment instructions truthful. |
| O05 lifetime | Rotate refresh token; replay old token; simulate long inactivity | Policy-specific renewal works; replay/revocation deny access; expired grants not revived. |
| O06 optional avatar | Same upload twice, other agent/company, restricted token, export/import | Self-scoped, normalized, idempotent; no private asset ID portability leak. |
| D01 event duplication | Duplicate and reorder signed event deliveries | Same mailbox/assignment processed; no duplicate effects. |
| D02 event delay | Deliver after acceptance deadline or during reconnect | Stale offer rejected/reconciled; no new authority from an old event. |
| D03 resubscribe | Subscription expires with outstanding work | Reverification and fresh reference to existing work; no replayed effects. |
| D04 cursor concurrency | Commit two mailbox writers around an inbox read | Cursor cannot skip a later-committed result. |
| D05 callback authority | Failed ownership challenge, wrong signature, replay where applicable | No unverified subscription or unauthorized state transition; correct signing material stays secret. |
| D06 callback egress | Private-address destination, redirect escape, timeout, repeated failure | Destination policy enforced; bounded attempts and visible failure; no internal-network access. |
| R01 response loss | Drop response after a document mutation | Same ID retrieves same effect/receipt; revision count stays one. |
| R02 ambiguity | Kill controller after external mutation starts | Unknown outcome surfaced; no automatic second effect. |
| R03 definite error | Read a nonexistent file/skill | Terminal bounded error; later tools and finish still work. |
| R04 stale controller | Late callback after ownership generation changes | Cannot overwrite newer state; late effect evidence retained. |
| R05 missing checkpoint | Remove/mismatch recovery evidence after dispatch | Reconciliation required; no replacement assignment disguised as resume. |
| R06 completion order | Finish with pending tools or changed report | Rejected until contract satisfied; canonical result retained. |
| R07 shutdown | Acknowledged shutdown before monitor's next poll; absent exit code | Clean exit recognized only with authenticated terminal evidence. |
| A01 identity | Cross-company IDs, wrong agent/resource, invalid pairing hint | Denied by server; no authority selected by caller fields. |
| A02 review/people | Review another agent's task; assign to a human | Legitimate mode-specific access works without granting unrelated task writes. |
| A03 live grant loss | Revoke setting/grant during a protected read | No new protected response after revocation. |
| A04 API fallback | Try file download/upload through generic API tool | Same attachment/workspace rules apply; no alternate-path bypass. |
| S01 skills/apps | Pinned synthetic skill; assigned gateway tool; tool revocation | Correct version/digest and normal gateway auth/receipts; stale catalog can't override authority. |
| F01 attachment | Answer only on page two; corrupt/hash-changed/oversized files | Correct bounded paging and integrity errors; no data from another task. |
| F02 artifact | Produce and register output | Downloaded bytes and SHA-256 match; task links the usable work product. |
| W01 workspace | Traversal, symlink, instance config, credential access | Confined or denied across every file and upload path. |
| W02 commands | Detached descendants, timeout, cancellation | Supervisor and descendants contained/terminated; unavailable platforms fail closed. |
| W03 concurrent edits | Two writes with same observed hash | At most one commits; second sees conflict. |
| C07 placement | Idle reads; many tools/messages in one active task | No idle compute; same admitted Runner/lease reused. |
| C08 artifact mismatch | Managed image contains pre-provider Runner | Capability/digest check rejects before advertising work. |
| C09 terminal failure | Allocation timeout, failed admission, orphan offer | Clear terminal receipt, no blocked future work, tracked cleanup. |
| C10 deploy | Fresh tenant and shipped images through real ingress | OAuth, anonymous consent, both work directions, and cleanup pass. |

Long-duration subscription/refresh tests need real provider time as well as fake
clock unit tests. Select a duration consistent with the release claim; a five-minute
demo does not establish multi-day availability. Do not leave a paid soak running
without authorization, ownership, limits, and a supported monitoring mechanism.

## Record evidence that survives a handoff

Use one row per case and candidate; do not combine incompatible partial runs into
one green campaign. A useful record is:

```yaml
case: C05
candidate:
  appCommit: <sha>
  ingressCommit: <sha-or-not-applicable>
  appImageDigest: <digest>
  runnerArtifactDigest: <digest>
environment: <tenant-or-isolated-instance>
client: actual-provider # or scripted
startingState: <fresh/connected/accepted/etc>
identities:
  run: <id>
  assignment: <id>
  session: <id>
  lease: <id>
  controllerBefore: <id>
  controllerAfter: <id>
  processFingerprintBefore: <redacted-reference>
  processFingerprintAfter: <redacted-reference>
interventions: []
observed: <receipts, document revisions, task state>
evidence: <log/screenshot/artifact links>
cleanup: <released/destroyed/pending with provider receipt>
outcome: PASS # FAIL / BLOCKED / UNVERIFIED / NOT_APPLICABLE
limits: <which release claims this does not establish>
```

Keep secrets, callback signing keys, access/refresh tokens, pairing codes, and
private source data out of reports and public PRs. Internal IDs may belong in a
private qualification record; follow the repo's public issue/PR rules.

## Historical Paperclip test entry point

The October 9 integration used `server/src/__tests__/dot-runner.test.ts` for
actual Rust/PostgreSQL tests and an opt-in private Daytona case:

```sh
pnpm exec vitest run server/src/__tests__/dot-runner.test.ts -t 'private Daytona Rust'
```

That candidate read `PAPERCLIP_DOT_DAYTONA_LIVE=1`, `DAYTONA_API_KEY`, an immutable
`PAPERCLIP_DOT_DAYTONA_IMAGE`, optional `PAPERCLIP_DOT_DAYTONA_RUNNER_BINARY`, and
`PAPERCLIP_DOT_DAYTONA_EVIDENCE`. Locate the current fixture and inspect its flags,
cost bounds, dependencies, and `finally` cleanup before running. Do not print
credentials. This case used a scripted MCP client; it never replaced real Dot
qualification. The command/flags are historical anchors, not a guaranteed current CLI.

Run the smallest decisive tests while iterating, then the repository-required
typecheck/test/build and review gates on the final candidate. A stale broad suite
running across source edits is not evidence for the final revision. Separate
unrelated infrastructure failures from product regressions, retain failed attempts,
and re-run affected cases after fixes.
