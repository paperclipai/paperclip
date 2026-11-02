# Native connection evidence and continuation repair

## Finish line

Fix the observed decline-grading races and qualify an explicit per-turn native
completion reminder. Keep the prompt reduction in #15489 draft. Do not merge.

## Changes and evidence

The evaluator waits for the final successful lead run's attributed saved reply
before grading a decline, with the original deadline unchanged. Wrong wording
still fails. Both explanation checks recognize the observed unavailable/rejected
and "wasn't able to pull" responses. The exact grading input is retained before
later refreshes. A recorded tool-action rejection may await its bound continuation
within the same deadline, just like an executed approval.

Compact resumed inputs remind the provider to obtain an accepted completion or
block report for the current turn. Earlier reports and final prose are not a
replacement. The strict native result gate, original connection prompt, tool
catalog, permission enforcement and automatic retry policy remain in place.
This is an instruction repair hypothesis; local tests alone do not establish
that a model will follow it.

## Bounded comparison

Freeze a common evaluator baseline on master `fc6304dfe5f2e446e09bd052a7b45f51e930f250`.
Use identical evaluator, fixture, prompt, model, profile, permission and budget
inputs in both variants. The candidate alone adds the compact per-turn reminder.
Select the fifteen explicit `native-connection-guidance` local cells: five
connection stories across native Codex `gpt-5.6-sol`, ACPX Claude `claude-sonnet-5`,
and OpenCode `openrouter/deepseek/deepseek-v4-flash-0731`. One attempt per variant
and cell, no automatic retries, 720000 ms cell deadlines, 1000-cent company and
agent hard stops, and three concurrent cells per campaign. Count every actual
run, including failures; preserve source and grader hashes and incomplete billing.

The old campaigns 37688433682 and 37688449963 remain original 11/15 and 12/15
results with two new failures. This follow-up does not regrade or qualify those
trees. A passing workflow command is not a behavioral grade. Inspect saved output,
accepted reports, exact pairs, decisions, tool use and cleanup before readiness.

## Validation so far

- 25 focused evaluator tests pass, including delayed/missing/wrong-run replies,
  incorrect output, and accepted/rejected continuation deadlines.
- 194 native contract, instruction-delivery and session tests pass. A correct
  visible provider answer without a semantic completion still fails closed.
- Full validation and the fresh paired live comparison are pending.
