# Runner API production readiness — 2026-09-07

The feature is not ready for a general release. The first stage showed useful
API access and no unnecessary fallback calls in 69 valid Luna regression runs.
Coverage, complete accounting, and final release checks remain incomplete.

## Latest evidence

- OpenCode 1.18.17 starts with the existing Sonnet 5 and DeepSeek V4 Flash 0731
  OpenRouter profiles. These startup checks make no model request.
- One paid Sonnet task used `get_task_context`, `search_api`, then `call_api`.
  The real project-list route returned HTTP 200.
- The overall attempt failed. The harness omitted the runner completion contract.
  The worker now supplies it, but has no paid retest of the fix.
- The runner failure interrupted final usage capture. The ledger contains about
  $0.96 in known estimated/provider-reported charges across both stages, but the
  final request's cost is unknown. Further paid calls remain blocked.
- DeepSeek has no paid capability result. Gemini has not been attempted.
- Focused checks pass: 19 runner tests, 16 harness tests, and runner typecheck.
  Full-repository tests were not rerun in this follow-up. Earlier full-suite
  failures remain recorded in the first-stage verification report.

## Recommended order

1. Make usage records survive runner failure and disposable server cleanup.
   Retain provider request IDs and final usage in the immutable attempt directory.
   Recover the missing failed-request billing record before further paid calls.
   Test interruption before, during, and after a provider response without spend.
2. Repeat one Sonnet read. Require correct HTTP output, a valid runner completion,
   and complete usage. Then run read, write, and denial cases on Sonnet and
   DeepSeek. Preserve exact model, runtime, routing, pricing, and effective
   reasoning settings. Keep the profiles separate in the report.
3. Run three paired ordinary workflows on each model with identical fixtures and
   settings. Check success, unnecessary API fallback, call counts, total cost,
   and elapsed time. Investigate changes over 20%; a small sample is not proof
   of a regression. Recheck Luna child creation and agent listing, where earlier
   samples showed cost increases. Resolve the child-creation audit gap shared by
   both arms before counting that workflow as correct.
4. Fix known discovery and fixture failures. Build from one case to three, then
   ten. Add operation families in batches of at most 25. Prioritize permissions,
   lifecycle restrictions, files, uncertain mutation outcomes, and API options
   absent from dedicated tools. Generated scenarios need valid fixtures and
   explicit persisted-state assertions before they establish coverage.
5. Verify the final source on the actual Linux production runtime. Run the
   required contract checks, typecheck, tests, and build. Resolve or isolate each
   existing full-suite failure with evidence. Test stale runs, company boundaries,
   Ask/Plan restrictions, file containment, replay, and terminal completion.
6. Prepare a small opt-in rollout with an operator-controlled disable switch.
   Observe task correctness, fallback rate, cost, latency, permission denials,
   and unknown mutation outcomes. Use existing local run logs where possible.
   Expand only after the small rollout passes the same acceptance checks.

The original $300 ceiling covers all attempts and retries. Keep the same ledger.
About 61 of the original 90 active campaign minutes have been used. Do not spend
on the full suite until the accounting and small-case gates pass. The operator
rollout switch and production rollout are proposed work, not completed features.
