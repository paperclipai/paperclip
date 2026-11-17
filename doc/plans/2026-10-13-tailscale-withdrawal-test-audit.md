VERIFIED: retire one repeated Tailscale idempotent-withdrawal execution while preserving its assertion union.

Exact parent: #16099 at 8e955181d8a3776acc86e4662de3c77933231a76. Production is unchanged. The test file changes from 593 to 559 lines and 22 to 21 cases (2 additions, 36 deletions); one reserve/expose/reserve/expose fake-broker sequence is removed. No wall-clock performance claim.

Full-owner controls, run serially: baseline 22/22 pass; candidate 21/21 pass; full revert 22/22 pass; restored candidate 21/21 pass. A real production mutation made the retained test fail at its removal-count assertion. Source was restored and byte-verified before the final passing run. Production SHA-256: c957d6ee89d61af6e8bfaac699bb4ed2d1d9fc1b12da89bffba613451cfd47d5.

Reproduce from the repository root with: pnpm --filter @paperclipai/tailscale-https-broker exec vitest run src/broker-core.test.ts

Mutation check: in packages/tailscale-https-broker/src/broker-core.ts, inside the leaseWasExposed branch that handles substituted ports, temporarily remove the statement that adds each substituted port to appliedPorts (currently: if (!appliedPorts.includes(port)) appliedPorts.push(port);). Re-run the same owner command: the retained test “withdraws an idempotently-skipped mapping whose listener was substituted” must fail at expect(fake.removeCalls).toBeGreaterThan(0). Restore the source and rerun to confirm the owner passes. This mutation skips the withdrawal admission and leaves the keeper's provider-removal assertion to catch it; it does not alter the candidate test.
