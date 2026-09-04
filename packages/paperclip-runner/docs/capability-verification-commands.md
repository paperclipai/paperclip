# Capability Verification Commands

Every command here runs from the repository root, is offline and deterministic,
starts no Paperclip service, and holds no credential. All are prefixed
`pnpm --filter @paperclipai/paperclip-runner`.

| Surface | Command | Expected result |
| --- | --- | --- |
| Capability contract completeness and drift | `check:capability-inventory` | `Capability inventory completeness and generated-output checks passed.` |
| Contract validator negatives | `test:capability-inventory` | 4 tests pass |
| Mock control plane + shared port | `exec vitest run src/conformance/control-plane-port.test.ts src/mock-core/capability-mock-control-plane-adapter.test.ts` | 9 tests pass |
| Semantic tools + authorization/redaction | `exec vitest run src/tools/capability-semantic-tools.test.ts` | 9 tests pass |
| 106-case conformance | `test:capability-evals` | 1 file (all 106 cases) passes |
| Fake-agent matrix + bounded Codex + parity report | `report:capability-evals` | `Capability eval conformance passed: 106 cases across 16 groups.` |
| Scenario runtime + explorer + clean room + routes | `test:scenarios` | 159 tests pass |
| Browser IA, accessibility, determinism, boundary | `test:browser:scenarios` | Playwright suites pass (60 in the issue-thread/clean-room suite) |
| Screenshot acceptance set | deferred recorded-evidence campaign | 24 deterministic images |
| Documentation links | `docs:validate` | all local links resolve |

## Live commands (not offline)

The clean-room chat has no fake or replay path, so its end-to-end proof needs a
Rust toolchain and a locally authenticated Codex. These are the only Capability
commands that start a provider.

| Surface | Command | Expected result |
| --- | --- | --- |
| Real Codex through real runnerd on a fresh mock tenant | `smoke:capability:cleanroom` | every assertion `true`; two `MCK-` identifiers, one per chat |
| Preset issue thread against real Codex | `smoke:capability:ui` | every assertion `true` |
| Clean-room screenshots | deferred recorded-evidence campaign | 7 images; intentionally not byte-stable |

## Notes

- **No Rust toolchain is needed** for any Capability command. The full
  `verify` target still builds the Rust workspace, but nothing above does.
- **Determinism.** Fake-mode runs render fixture time only, so repeat runs and
  repeat screenshots are byte-identical.
- **The parity report is generated on demand.** `report:capability-evals` writes
  `.paperclip-local/evidence/capability/eval-parity-report.{json,md}`, which are not
  committed or scanned by `docs:validate`.
- **Browser libraries.** On minimal or rootless hosts, extract Playwright's
  browser libraries first; the package's `verify:rootless` target shows the
  pattern.

## Related

- [Clean-start tutorial](tutorials/capability-scenario-explorer.md)
- [Eval conformance](capability-eval-conformance.md)
- [Scenario explorer](capability-scenario-explorer.md)
- [Clean-room live chat](capability-clean-room-chat.md)
