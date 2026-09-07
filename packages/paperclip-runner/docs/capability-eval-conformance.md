# Capability Eval-Derived Conformance

Capability turns the Paperclip Evals corpus into an executable, offline
conformance suite. The suite derives its cases from the checked-in Capability
traceability derivative (`spec/capability/eval-traceability.yaml`) — it does
**not** clone or read an external eval repository, and it starts only the
in-process mock control plane. It hard-fails unless the derivative declares
schema version 2, exactly 106 rows, exactly 16 groups, and unique case IDs.

Sources: `src/conformance/capability-eval-suite.ts` and its test
`src/conformance/capability-eval-suite.test.ts`; the reporter
`scripts/run-capability-eval-suite.mjs`.

## The corpus

- **106 cases across 16 groups.** Per-group counts: hb 5, co 6, st 8, cm 6,
  se 4, su 4, bl 5, dp 3, ix 9, ap 6, ar 4, er 9, rf 22, mh 4, rs 3, wk 8.
- Each case declares an actor role, a task mode, an input scenario, and the
  expected outcome, all bound to a row in
  [the capability contract](capability-contract.md).

## Assertion classes

Every case belongs to one assertion class, and each class checks a different
kind of invariant:

- **`agent_tool_contract`** — a semantic tool call produces the expected typed
  effect and state change.
- **`authorization_policy`** — a capability is exposed, denied, or unlocked by a
  grant exactly as its disposition requires.
- **`control_plane_invariant`** — a control-plane-owned action happens without
  any agent tool, and no tool can perform it.
- **`combined_multi_hop`** — a sequence of operations across turns produces the
  expected cumulative state and respects forbidden-operation rules.
- **`restraint_no_call`** — the correct behavior is to make **no** call; the
  case passes only if the agent deliberately does nothing further.

## Fake-agent matrix and bounded Codex sample

The suite executes each case with a deterministic fake agent whose plan is
fixed by a fixture seed, so repeat runs are byte-identical. Optional-tool rows
are run twice — once with the unlocking grants (must be allowed and must mutate
state) and once ungranted (must be absent or denied with no state change);
control-plane-owned rows remain absent in every configuration; and
`restraint_no_call` rows must produce an empty state diff.

The fake-agent surface is 14 always-agent tools plus 4 optional tools unlocked
by four seed grants (`discovery:tasks:read`, `discovery:agents:read`,
`delegation:tasks:create`, `governance:approvals:request`) — **18 operations**.
The suite binds that surface through both the fake-agent and Codex bindings and
asserts the two operation lists are byte-identical (**18/18**).

A **bounded Codex binding sample** picks one representative case from nine
groups (`hb`, `dp`, `bl`, `ap`, `ar`, `ix`, `mh`, `rs`, `wk`) and checks that
`checkout_task` is absent from the Codex surface while every other sampled
operation is present. It is an offline parity check; no real Codex or network is
contacted, and the browser explorer holds no credential.

## Running it

```sh
# Run the 106-case suite in-process (one vitest file drives all cases).
pnpm --filter @paperclipai/paperclip-runner test:capability-evals

# Build the public surface and write the parity report with per-group counts,
# assertion classes, the fake-agent matrix, the bounded Codex sample, and the
# semantic-operation execution counts.
pnpm --filter @paperclipai/paperclip-runner report:capability-evals
```

The reporter writes `.paperclip-local/evidence/capability/eval-parity-report.{json,md}`.

Run the bounded provider conformance matrix separately. It creates exactly one
real Codex turn for each of the 16 checked-in eval groups while retaining the
in-process mock control plane:

```sh
pnpm --filter @paperclipai/paperclip-runner report:capability-live-evals
```
Each failure carries its case ID, assertion class, semantic operation,
authorization decision, and final state diff. The report is generated on demand
and is not committed; delete it before running `docs:validate` (it carries no
OKF frontmatter). See the
[verification commands reference](capability-verification-commands.md).

## Related

- [Capability disposition](capability-disposition.md)
- [Semantic tool catalog](capability-semantic-tools.md)
- [Scenario explorer](capability-scenario-explorer.md)
