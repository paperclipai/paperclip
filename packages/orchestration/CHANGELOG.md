# @paperclipai/orchestration

## 0.1.0

- Initial core slice: pure `route()` router, tenant-injected policy
  (`RouterDependencies.policy`, empty `DEFAULT_POLICY`), model catalog + pricing
  snapshot, long-context promotion hooks, and the per-call telemetry contract.
- Ships `EXAMPLE_POLICY` as a reference routing table.
