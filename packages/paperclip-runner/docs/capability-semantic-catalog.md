# Capability semantic catalog and authorization

Capability adds a transport-neutral tool boundary over the deterministic mock
`ControlPlanePort`. It does not contain Paperclip REST routes, authentication
headers, credentials, ACPX code, or a real control-plane binding.

## Public boundary

Import the catalog, policy, dispatcher, and binding helpers from the package
root:

```ts
import {
  CapabilitySemanticDispatcher,
  createCapabilityProviderNeutralBinding,
} from "@paperclipai/paperclip-runner";

const dispatcher = new CapabilitySemanticDispatcher(mockPort, {
  scenario: {
    id: "dependency-manager",
    claims: ["dependencies:write"],
  },
  explicitClaims: ["dependencies:write"],
});

const exposed = dispatcher.listTools(runId);
const result = await dispatcher.dispatch({
  runId,
  callId: "tool-call-1",
  operationId: "set_dependencies",
  input: {
    idempotencyKey: "dependency-change-1",
    blockedByTaskIds: ["task-2"],
  },
});
```

`createCapabilityProviderNeutralBinding("fake")` and
`createCapabilityProviderNeutralBinding("live_codex")` return identical contract
arrays. Only the binding label differs. Track 7E can translate those definitions
to Codex tool definitions and pass calls to the dispatcher without changing
operation IDs, schemas, claims, or result shapes.

## Authorization order

Exposure and invocation both evaluate the actor, active-task ownership and
mode, scenario allow/deny rules, role restrictions, run claims, and explicit
claims. Optional operations require their descriptor claim to be present in the
intersection authorized for the run. The dispatcher repeats the evaluation
immediately before every mock read or command; a tool that was exposed earlier
can still be denied after a claim or ownership change.

Unauthorized optional tools are absent from `listTools`. Direct calls receive a
`paperclip.semantic-denial.v1` result. The mock command boundary independently
checks command claims and task ownership, so bypassing catalog exposure does not
bypass authorization.

The generic API escape hatch is an optional `skill_test` descriptor and is
disabled by default. When a scenario and explicit claim enable it, only two
read-only package-local paths are accepted: `/mock/state/revision` and
`/mock/task`.

## Protected data

Tool schemas contain no credential fields. Inputs containing protected keys or
credential-shaped values are rejected before mutation. Read results, denials,
and immutable semantic authorization records pass through the same recursive
redactor. Mock actor discovery also omits capability and budget internals.

Generate and verify the checked-in contracts with:

```sh
pnpm --dir packages/paperclip-runner generate:semantic-contracts
pnpm --dir packages/paperclip-runner check:semantic-contracts
```

The generated contract is
`generated/capability/semantic-tool-contracts.json`. Capability traceability remains
under `generated/capability/` and is checked with `check:capability-contract`.
