# Semantic action catalog

The package exports a versioned, provider-neutral catalog for the first Codex
runner slice. Each declaration has a stable operation ID, placement metadata,
required claims, supported task modes, an effect class, and JSON Schema input
and output contracts.

The catalog is descriptive. Importing it or finding an operation in it does not
grant permission to show or call that operation. A run-scoped dispatcher can
project only actions that have current actor, task, company, claim, mode, and
application-binding authority. It rechecks that authority before each call.
The package still adds no application binding, credential, server route, or
Codex tool installation. Until a later server integration supplies those
bindings, Codex receives no dynamic Paperclip tools.

The initial catalog excludes scenario-only and lab operations, other-provider
extensions, and a generic API escape hatch. Those additions need their own
reviewed schemas and authority boundaries.

## Public API

```ts
import {
  PAPERCLIP_SEMANTIC_ACTION_CATALOG,
  paperclipSemanticAction,
} from "@paperclipai/paperclip-runner";

const writeDocument = paperclipSemanticAction("write_document");
```

`PAPERCLIP_SEMANTIC_ACTION_CATALOG` and every nested declaration are frozen.
`paperclipSemanticAction` returns `undefined` for unknown operation IDs.

## Run-scoped authority

`PaperclipSemanticDispatcher` accepts a current-context provider and an
explicit list of application bindings. Unbound actions are absent. Actor claims
and run-delegated claims are intersected. Optional discovery returns only bound
actions that pass the same authorization check. Mutation actions also require
an atomic idempotency store. The store must provide an idempotent recovery path
for a mutation that succeeds before its primary receipt commit fails. Raw tool
content never enters semantic receipts; receipts contain a digest and
allowlisted references only.

## Generated inventory

`generated/semantic-action-catalog.json` is a deterministic projection of the
runtime declarations. Change the TypeScript source, then run:

```sh
pnpm --filter @paperclipai/paperclip-runner generate:semantic-action-catalog
```

The package build and catalog tests compare the checked-in inventory byte for
byte. Do not edit the generated file directly.
