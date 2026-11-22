# ACPX lifecycle test ownership

The engine's primary behavioral boundary is `createAcpxEngineExecutor` in
`execute.test.ts`. `run-fault-matrix.test.ts` owns resource acquisition/failure
outcomes. Sequence, cancellation, session-store, and workspace restore tests
retain their separate ordering and persistence contracts.

- Extend the existing harness or literal case table before creating another
  full executor/bridge/sandbox mock graph. Temporary characterization suites
  must have a cutover plan; migrate their unique assertions when the refactor
  finishes rather than keeping both layers indefinitely.
- A provider adapter suite needs a distinct provider configuration, credential,
  prompt, parser, or transport contract. Do not replay shared lifecycle proof
  merely under different adapter names.
- Verify actual close, cancel, bridge-stop, restore, and lease-release callbacks
  when guarding physical cleanup. Ledger dispositions alone do not establish
  that the cleanup ran or that ordering is correct.
- Keep stalled-phase/Stop tests at the live engine boundary. Pure sequence
  tests cannot replace callback wiring while real awaits are held open.
- Before retiring a layer, map every unique assertion to a keeper, obtain an
  independent preservation review, and use focused mutations for repaired gaps.
  Never remove a baseline failure to make the suite green.
