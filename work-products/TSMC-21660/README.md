# TSMC-21660 close evidence

Capability boundary: agent lanes must not execute pinned-deploy scripts.

## Scope status (issue TSMC-21660)

1. **Agent-context refusal** — already implemented in `scripts/pinned-deploy-promote.sh`
   (`assert_not_agent_lane`, commit `618796ffb`). Fences every mutating sub-command
   when `PAPERCLIP_AGENT_ID` / `PAPERCLIP_RUN_ID` is present, unless the operator sets
   `PAPERCLIP_PINNED_DEPLOY_ALLOW_AGENT_CALLER=1`. Read-only sub-commands
   (`show-receipt`, `assert-green`, `lint-plists`, `--help`) stay available to lanes.
   Transcript: `agent-context-invocation-refused.txt`.
2. **Fail-closed on lease-dir deletion mid-flow** — already implemented: only
   `prepare-candidate` calls `acquire_deployment_lease` (mkdir-based); every later
   mutating command (`run-gates`, `candidate-boots`, `promote-pointer`,
   `promote-and-restart`) calls `require_deployment_lease`, which demands an existing
   `owner.json` matching the caller's token and fails with `no deployment lease;
   begin with prepare-candidate` if the lease dir is missing. It never falls back to
   re-acquiring, so `rm -rf` of the lease no longer grants entry. Added a dedicated
   regression test for this exact attack shape: `rm -rf of the lease dir mid-flow
   fails closed, it does not silently re-grant entry (TSMC-21660)` in
   `scripts/__tests__/pinned-deploy-promote.test.mjs`.
3. **Ops-rule, sourced outside AGENTS.md** — `~/scripts/ops-rules/deploy-scripts-operator-only-block.md`
   (Gate DEPLOY1), synced into every instruction layer by `~/scripts/ops-rules-sync.sh`
   (managed block, not hand-edited into AGENTS.md).

## Evidence

- `agent-context-invocation-refused.txt` — live invocation of
  `promote-pointer --allow-live-pointer` with `PAPERCLIP_AGENT_ID`/`PAPERCLIP_RUN_ID`
  set, refused at the door.
- `pinned-deploy-promote-test-suite-21-pass.txt` — full suite run, 21/21 pass,
  including the new lease-deletion regression test and the pre-existing
  agent-lane-refusal test (TSMC-21652).

## Commits

- `618796ffb` fix(deploy): refuse mutating deploy commands invoked from an agent run
- `e7c118724` fix(TSMC-21597): the deployment lease protected nothing between commands
- `eb7bf1845` fix(TSMC-21660): make pinned-deploy test suite hermetic to the invoking agent env
- (this run) test(TSMC-21660): add rm -rf-mid-flow lease-deletion regression test
