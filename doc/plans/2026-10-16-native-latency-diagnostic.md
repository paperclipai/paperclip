# Native latency diagnostic — 2026-10-16

Status: the explicit local-controller/real-Daytona comparison passes.
This branch also overlaps verified sandbox launch assets. PAP is unchanged.

Use the existing Product E2E basic-response journey and its independent exact
answer, run state, task state, runtime and environment checks. The new manual
suite selects only native Codex `gpt-6.1-sol`, a warm session with a five-minute
idle timeout, and the existing reusable Daytona fixture. It stays out of `--all`
and the ordinary `runner-codex` selector. It uses a 1,000-cent agent hard stop,
one expected run, the original deadlines, and no automatic retry.

The staging comparison uses subscription authentication. This experiment uses
an API key. A fresh local database and fixture instructions do not reproduce
staging company data, Slack admission or Slack delivery. Separate controller
setup and provider timing. Do not report the result as exact staging or release
qualification. Keep the selected image and executable digests in the evidence.

Credential-free discovery and the harness typecheck pass. The first typecheck
failed on an unknown fixture payload type; the final typecheck corrects that
cast without changing production types. The initial full support invocation
failed seven cases: two catalog totals changed, one existing Pi version
expectation differs from its source, and four installed-startup cases correctly
reject pnpm's injected `NODE_PATH`. The affected catalog totals are updated.
Direct Node invocation of the catalog, diagnostic, installed-startup and fixture
checks passes 63 cases. The Pi mismatch is retained as a failed attempt and repaired separately below.
No paid or live result is claimed by these checks.

The local preparation-overlap candidate remains on a separate local branch.
It is not part of this timing baseline.

## Real Daytona baseline and next slice

The corrected current Core linux/amd64 runner artifact passes the exact answer,
run/task, native mode and Daytona matchers; cleanup passes. Its traced repetition
on source `ac86e9e7668b` has a 22.878-second active run and 10.233-second queue
while this newly created agent is activated. Whole-case time is 52.788 seconds.
This does not establish a sub-30-second submission-to-answer or Slack result.
The earlier stale local binary failed native provider identity validation and
its failed cleanup grade remains; an independently scoped follow-up confirmed
its nine owned Daytona sandboxes retired. Neither attempt changes PAP.

The traced repetition stages fresh harness launch material for 621 ms, then
immutable runtime context for 615 ms. Both use disjoint session paths. Extract
this responsibility first with serial semantics, then overlap these two steps
only for a sandbox runner that explicitly advertises concurrent sync. Await both
outcomes before returning, retain launch-material error priority, keep CA staging
last, and leave SSH and undeclared runners serial with first-error termination.
Durable restore, artifact checks, ownership, permissions and process launch stay
in the existing orchestrator.

Other defensible boundaries in the oversized executor are durable checkpoint
restore, verified artifact preparation, transport/process supervision and provider
credential lifecycle. They remain outside this bounded latency change. The
launch-asset extraction moves about 120 lines with explicit stage callbacks and
no new shared state or runtime dependency on the executor. Check its serial
behavior before introducing concurrency, then use barriers to verify overlap,
wait-for-all failure handling and unsupported transport behavior. Compare one
matched real-Daytona candidate against the saved baseline; provider variation
must remain separate from the launch phase saving.


## Candidate result

On frozen source `e9404a585000`, the same model, Daytona image, Linux runner
binary and local trace setup pass the exact answer and all result matchers.
Cleanup passes. Launch material and immutable context both start at offset
12,785 ms and remain sibling spans under `stage.sync`. Their transfer times are
644 ms and 691 ms. Total staging falls from 1,552 ms to 1,017 ms (535 ms, 34.5%).
Runner bootstrap falls from 4,761 ms to 4,207 ms.

The active run falls from 22,878 ms to 20,157 ms. This larger difference is not
attributed to staging: agent execution changes from 9,026 ms to 7,015 ms,
settlement increases from 1,600 ms to 2,769 ms, and preparation also varies.
Fresh-agent activation queue changes from 10,233 ms to 6,245 ms. This is one
matched pair, not a statistical tail-latency or Slack acceptance result.

Before extraction, all 736 existing executor cases pass. The serial extraction
passes 741 cases. The concurrency assertion then fails on serial source as
expected. The candidate passes 764 executor, staging and tracing cases; the
12-case staging suite passes again after its fixture adds required process-result
fields. Full repository typecheck and build pass on the candidate. The earlier
server typecheck failed because that mock omitted signal, pid and startedAt;
production contracts were unchanged. The first sandboxed regression attempt
cannot start a loopback database and is interrupted; its authorized repetition
passes. The broad pre-existing support-suite failures above remain recorded.

No additional paid iteration or unchanged PAP message is needed for this slice.
Complete final-branch CI and review before any PAP rollout.


## Review corrections

The first review identifies that diagnostic metadata alone does not enforce its
single-attempt promise. The selected task now sets the existing `single_attempt`
policy. A test through the effective retry-limit function fails before this fix
and checks zero retries even when the command requests 99. The measured real
cases already pass explicit `--max-automatic-retries 0`; none is retried.

The Pi profile pin has a separate stale expectation from the already-merged
preconfigured-home profile update. Update both metadata expectations from 22 to
23. Recomputing the old suite with only profileVersion 22 reproduces the old
pinned hash exactly; the new expected hash changes only that metadata value.
All 72 Pi identity/control/evidence tests pass. The full authorized support run
passes 2,763 cases before adding the retry regression. This does not rewrite the
original failed support invocation. Native production source remains identical
to the measured optimization.
