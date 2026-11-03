---
name: fix-failed-paperclip-run
description: Diagnose and fix failed, stuck, slow, or incorrectly blocked Paperclip tasks and runs. Use with a task/run URL or failure report to trace the root cause, prove a regression red then green, check second-order effects, verify the real workflow, and deliver a PR with passing checks.
---

# Fix Failed Paperclip Run

Own the failure from evidence through a tested repair and a green PR. A diagnosis,
a proposed plan, a successful provider turn, and a passing unit test are intermediate
results. The finish line is a verified user workflow and a PR whose current commit
passes the required checks and review.

Honor an explicit diagnosis-only request or a calling workflow's approval boundary.
Otherwise proceed through implementation without a separate plan-approval pause.
Carry forward existing authorization for merge, rollout, and recovery; do not ask
again. When the assignment ends at a PR, distinguish local verification from
deployment and recovery of the original task. This skill does not itself authorize
merging or deploying.

## 1. Establish the incident and the finish line

Start from the supplied task/run URL or failure report. Resolve these facts from
available tools and records before asking the user for missing information:

- Instance, company, task, affected run(s), time window, and intended useful result.
- Current state versus state at failure; parent/child tasks and pending interactions
  only where they control progress. Multiple failed runs can have different causes.
- The code actually served, runner/provider pack versions, operating system and
  architecture, adapter, model/effort, execution workspace, trust mode, and credential
  source. Trace effective values back through task overrides, inherited settings,
  defaults, and saved session state. Redact credential values.
- Which endpoint is authorized: verified fix and green PR, or also rollout and
  recovery. Preserve the requested work and success criteria throughout.

Use authorized diagnostic access. If company scoping blocks a read, use an
already-authorized diagnostic path or label the missing evidence; do not bypass
the boundary.

Read repository instructions and the relevant current execution contract. In this
repository, use `doc/execution-semantics.md` for ownership, continuation, waiting,
finalization, and recovery. Inspect recent changes and open/merged repairs in the
affected area. A correct fix that has not reached the target is a deployment gap;
do not create a second patch without evidence that the first is insufficient.
Choose code repair, configuration repair, or recovery from that evidence. If an
existing fix is sufficient, verify it and continue to the authorized endpoint
using its PR; do not manufacture code changes for an already-fixed defect.

Keep a compact evidence record in the working notes or driving issue: environment,
revision, causal timeline, reproduction, safety assumptions, and acceptance result.
Preserve useful logs and saved work before retries or cleanup. Do not put secrets
or private incident links in public code, fixtures, skills, or PR descriptions.

## 2. Find the first causal failure

Reconstruct the run from dispatch through preparation, provider execution, tool
calls, result persistence, finalization, and task disposition. For chat/email work,
follow outbound delivery and the user-visible result too. Align run events, logs,
controller/provider records, task activity, and traces by time and identity.

Separate these questions:

1. What first prevented useful work or its delivery?
2. Why did the responsible component make that decision or emit that value?
3. Why did recovery or continuation fail to complete the already-authorized work?
4. Which later errors are consequences, misleading summaries, or independent bugs?

Trace the causal value or transition to its producer and shared contract. Verify
the hypothesis against a counterexample or a reproduction. Check logs before and
after the apparent error: a recovered authorization warning may not be fatal, and
“final response,” HTTP 200, or “run succeeded” may not mean the task is complete.
Missing error detail is an evidence gap, not proof of a provider outage. When
evidence cannot distinguish hypotheses, name the uncertainty and add the smallest
bounded, redacted observation or fault injection that will resolve it.

For a stalled tree, classify each relevant non-progressing node as genuinely
waiting on a named human/external dependency, agent-actionable but unrouted, or
already covered by existing work. Preserve all three invariants:

- Productive work has a real next action and owner.
- Genuine approval, credential, budget, and dependency blockers remain effective.
- Recovery and continuation are bounded and cannot recursively recover themselves.

Consult [failure patterns](references/failure-patterns.md) for matching mechanisms
and test oracles. Treat them as hypotheses to check, not a catalog of explanations.

## 3. Prove the bug before changing production code

Write the smallest behavioral regression at the boundary that owns the defect.
Run it against the unfixed code and capture the expected failure. A setup error,
missing dependency, or assertion about a mock's own return value is not the red.

- Use the real policy/resolver/serializer and realistic persisted input. Mock only
  boundaries outside the behavior under test. If a query duplicates rows, exercise
  that query with the relational shape that produces duplicates.
- For recovery or races, control the interruption point and assert the resulting
  ownership, command receipts, side effects, and continuation. Restarting between
  completed turns does not reproduce a restart during an in-flight side effect.
- For packaging, process startup, platform, or cross-language defects, reproduce
  using the actual affected artifact or protocol. A host binary or mocked provider
  cannot prove that a sandbox image contains an executable compatible binary.
- For latency, measure the user's full interval and the suspected stage under the
  relevant cold/warm conditions. Use a stable controlled regression where possible;
  keep noisy wall-clock comparisons as measured acceptance evidence.

Keep this failing regression as the starting point for the repair. If the defect
requires a real integration environment, capture a
repeatable failing integration probe before the fix and repeat it afterward;
add a durable regression at the closest reliable boundary. If no meaningful red
can be observed, report that gap and keep working on reproduction. Do not claim
red-green proof from a test that was first run after the fix.

## 4. Repair the cause and prove the safety assumptions

Fix the responsible producer or shared transition at the narrowest correct scope.
Check sibling callers/adapters that share that contract; generalize only as far as
the evidence requires. Avoid historical string allowlists, swallowed errors,
unbounded retries, or relaxing an integrity check to accommodate malformed input.
Preserve the requested model, trust, isolation, and performance behavior unless a
change or explicit fallback policy is part of the assignment.

Before implementation, state the behavioral rule and the strongest plausible
second-order failure. Trace callers, downstream consumers, persisted state, and
runtime variants affected by the changed contract. Turn the important safety
assumptions into observable regression cases, not just assurances in the PR:

| Changed boundary | Safety evidence to consider |
| --- | --- |
| Ownership, cancellation, retry, or continuation | No second executor or repeated external side effect; legitimate queued work still runs; cancellation remains effective. An unchanged assignee field alone is insufficient. |
| Recovery or finalization | Saved files, results, and sessions survive; known-complete work is not rerun; interrupted work continues once; indeterminate outcomes reconcile before retry. |
| Waiting or task disposition | Real approval/budget/credential gates still stop work; actionable work has a durable wake; recovery is bounded; no recursive recovery tree. |
| Input, tool, or credential plumbing | Company and trust boundaries hold; intentional configuration reaches execution without ambient secret forwarding; distinct tools still dispatch correctly; sensitive logging remains redacted. |
| Packaging, compatibility, or session identity | Relevant local/sandbox, platform, fresh/resumed, and old/new artifact combinations work; obsolete saved values are handled by a contract rather than a list of incident exceptions. |
| Performance or lifecycle | Warm reuse remains warm where intended; queueing and finalization do not regress; configured deadlines retain their meaning. |

Select cases that exercise the actual blast radius. Do not create an unrelated
platform matrix. Test the sibling success path and the negative case that the old
guard protected. Keep reproduction and safety tests through later revisions.

With the red established and the safety assumptions identified, make the repair
and run the same regression green. Run the relevant safety cases and existing
tests. Refactor only while they stay green. Investigate unexpected failures
instead of weakening an assertion or deleting the regression to finish.

Routine infrastructure facts belong to the harness when it can determine them
under existing authority. Reconcile process ownership, saved results, or eligible
continuations in code instead of asking a user to certify those facts in a form.
Keep UI choices for genuine user intent, authorization, or unavailable information.

## 5. Verify the real workflow at the fixed revision

Apply the repository's `verify-paperclip` skill and affected map recipes when
available. Its essential requirement here is a real run through the affected user
entry point, using the fixed source or package and the relevant runtime configuration.
Run the narrow regression first so each hypothesis gets fast feedback; use a local
server with the real remote provider when that reproduces the failure. Do not wait
for a full deployment for every experiment when a faithful shorter loop exists.

Exercise the original failure mechanism with a representative task: actual adapter,
provider, tools, trust boundary, persisted state, artifact, and interruption point
where each matters. A mock, Storybook, provider-free benchmark, or generic “hello”
smoke is supporting evidence only when the incident depends on a different path.

Verify the useful output, persistence after reload/reconnect, finalization, and
correct task state with no stranded lock or pending operation. For resume and
conversation defects, run a second turn and check retained context/files. For
delivery defects, check the destination and user-visible outcome, not just receipt
of an HTTP request. For slowness, compare the end-to-end interval with the baseline.

Record the tested revision and runtime versions. Re-run affected acceptance after
changes that invalidate that evidence. Report any missing credentials, access, or
environment precisely; an unavailable live check remains unverified. Continue
independent repair and PR work instead of substituting an unsupported “works” claim.

## 6. Deliver the PR and close the incident to the authorized endpoint

Use `prepare-paperclip-pr` and `prcheckloop` when available. Follow repository
instructions for checks, branch isolation, PR template, and review. Open the PR,
address review and CI failures, and inspect required checks and review on the
current head SHA. Pending, skipped, and passing are distinct. Retry a failed check
only with a reason; retain its evidence and fix repeatable failures. Resolve
companion repository/artifact changes needed by the fix and state their ordering.

The PR must explain the causal defect, behavioral change, failing-before/passing-
after evidence, safety regressions, actual acceptance environment, and limitations.
Do not declare it ready while required checks or review remain unresolved. If a
required service or permission prevents completion, name the exact remaining gate.

When rollout/recovery is already authorized, continue: confirm the served revision
and required artifact versions, re-read the original task, and recover it through
the normal product path. Reconcile existing work before starting another executor.
Observe the original useful result or a genuine, named remaining blocker. Do not
cancel, replace, or shrink the user's original task merely to make a test pass.

Finish with a concise report:

- Root cause and what changed, with unresolved hypotheses labeled.
- Red/green regression and second-order behavior checked.
- Real workflow exercised, revision/environment, and observed result.
- PR URL, current check/review status, and companion changes if any.
- Whether the original task is recovered, still awaiting rollout, or blocked on a
  specific remaining dependency. Separate code readiness from incident recovery.

Do not stop at a plan when a fix is authorized. Do not call the incident resolved
because its error message improved or a successful run badge appeared.
