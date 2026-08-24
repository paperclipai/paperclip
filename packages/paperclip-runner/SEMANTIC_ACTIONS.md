# Semantic action catalog

The package exports a versioned, provider-neutral catalog for the first Codex
runner slice. Each declaration has a stable operation ID, placement metadata,
required claims, supported task modes, an effect class, and JSON Schema input
and output contracts.

The catalog is descriptive. Importing it or finding an operation in it does not
grant permission to show or call that operation. This change deliberately adds
no run-scoped projection, authorization decision, dispatcher, application
binding, credential, or server route. Until those layers land, Codex receives
no dynamic Paperclip tools.

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

## Generated inventory

`generated/semantic-action-catalog.json` is a deterministic projection of the
runtime declarations. Change the TypeScript source, then run:

```sh
pnpm --filter @paperclipai/paperclip-runner generate:semantic-action-catalog
```

The package build and catalog tests compare the checked-in inventory byte for
byte. Do not edit the generated file directly.
