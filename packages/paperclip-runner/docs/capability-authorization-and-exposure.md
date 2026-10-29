# Capability Authorization and Exposure

Two decisions gate every capability: **exposure** (is the tool even offered to
this actor?) and **invocation** (may this specific call proceed?). The
authorization engine answers both, produces typed denials that carry no
protected state, and redacts secrets before any observable boundary.

Sources: `src/tools/capability-tool-authorization.ts`,
`src/tools/capability-semantic-tool-runtime.ts`, `src/tools/capability-tool-bindings.ts`.

## Three-way classification

- **Control-plane-owned** — a frozen operation list (`checkout_task`,
  `release_task`, `select_work`, `route_wake`, `enforce_budget`,
  `append_audit_record`, `persist_run`, `replay_run`, `schedule_blocker_wake`,
  `reconcile_run`). `authorizeInvocation` short-circuits these to outcome
  `absent` with reason `control_plane_owned_operation`. No agent tool exists for
  them and none can be invoked.
- **Always-agent tool** — exposed to any actor whose task is active.
- **Optional-agent tool** — exposed only when a grant unlocks it.

## Exposure vs. invocation

- `computeVisibleTools()` walks the whole catalog and records, per tool, an
  exposure of `exposed` or `absent`, returning only the allowed tools.
- `authorizeInvocation()` re-evaluates at call time, producing `allowed` or
  `denied`.

Invocation is evaluated in order and fails at the first rule that rejects:
policy-denied operation IDs; task-mode membership
(`operation_not_available_in_task_mode`); role check
(`actor_role_not_authorized`); policy-denied claims
(`required_claim_denied_by_policy`); missing grants
(`required_claim_missing`); `read_secret_value` requires
`policy.allowSecretValueAccess` (`secret_value_access_disabled`);
`generic_api_request` requires the escape hatch to be enabled and the target to
be allowlisted (`generic_escape_hatch_disabled` / `..._target_denied`); and the
interaction-kind policy for `request_human_input`. Allowed calls carry the
reason `task_scoped_always_tool` or `required_claims_granted`.

Self-approval is prohibited even with the role and an explicit decision claim.

## How grants unlock optional tools

The actor's grants are the union of `capabilityGrants` (the actor's own) and
`scenarioGrants` (seeded per scenario). An optional tool unlocks only when
**every** entry in its `requiredClaims` is present in that union. Each
authorization record stores the `consideredClaims`, `grantedClaims`, and
`missingClaims`, so a denial explains exactly which claim was absent.

## Typed denials carry no protected state

A denial is a `CapabilityPolicyDenial`: `ok: false` with an `error.code` of
`policy_denied`, `operation_absent`, `input_invalid`, or `operation_unsupported`,
the `operationId`, a generic `reason`, and the authorization record. It carries
no fixture state and no protected payload. If the underlying mock operation
throws, the runtime emits `operation_unsupported` with reason
`mock_operation_rejected` and swallows the underlying error, so protected state
cannot leak through an exception.

## Secret redaction (the TASK-16909 rule)

Redaction is two layers:

1. **Model-only delivery is separated from every observable boundary.**
   `invoke()` returns a redacted `observableResult`. The only path to an
   unredacted secret is `invokeForModel()`, which returns a frozen capsule whose
   `toJSON()` and default serialization always yield the redacted form; only an
   explicit `readModelResult()` opens the raw value. The capsule uses a distinct
   schema (`paperclip.capability.model-tool-result.v1`) so it cannot be assigned to
   an observable sink by mistake.
2. **Path redaction rules.** `read_secret_value` redacts `$.value` to
   `[SECRET_VALUE]` across output, error, and authorization-record channels;
   `generic_api_request` redacts `$.headers.authorization` and
   `$.headers.cookie` to `[REDACTED]` across all channels. The scenario runner
   applies the same redaction again defensively at the explorer artifact
   boundary and injects only a placeholder secret value.

This is the security-gate outcome (TASK-16902) and its remediation (TASK-16909):
a real secret value reaches the model surface only, never a trace, artifact, or
browser view.

## Running the tests

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/tools/capability-semantic-tools.test.ts
```

The "exposure and authorization" and "security policy" describes cover typed
denials without protected state, model-only secret delivery, the self-approval
prohibition, and the test-only, explicitly granted, allowlisted escape hatch.

## Related

- [Capability disposition](capability-disposition.md)
- [Semantic tool catalog](capability-semantic-tools.md)
- [Scenario explorer](capability-scenario-explorer.md)
