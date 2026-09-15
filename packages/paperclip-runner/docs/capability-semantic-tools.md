# Capability Semantic Tool Catalog

The semantic tool catalog is the transport-neutral surface an agent may call. It
is a frozen set of JSON-schema descriptors — no HTTP method, path, or provider
detail. Provider-specific shapes are produced only by *bindings*, so every
provider sees the same operation set.

Each protocol action is single-sourced in its own module under
`src/protocol-actions/`. That module owns the action's policy metadata,
documentation, examples, and its live and scenario JSON-schema presentations.
`src/catalog/canonical-operations.ts`, `src/semantic-tools/catalog.ts`, and
`src/tools/capability-semantic-tool-catalog.ts` are compatibility projections;
do not add action definitions to them. See
[catalog reconciliation](../spec/capability/catalog-reconciliation.md).

Sources: `src/protocol-actions/`, `src/catalog/canonical-operations.ts`,
`src/tools/capability-semantic-tool-catalog.ts`,
`src/tools/capability-semantic-tool-types.ts`, `src/tools/capability-tool-bindings.ts`,
barrel `src/tools/index.ts`.

## Two dispositions, plus a separate control-plane list

A tool descriptor's `disposition` is either **`always_agent_tool`** or
**`optional_agent_tool`**. Control-plane-owned operations are a separate frozen
list, not a disposition — they are never exposed as tools. See
[capability disposition](capability-disposition.md) and
[authorization and exposure](capability-authorization-and-exposure.md).

The catalog holds **37 tools**: 14 always-agent tools and 23 optional tools
across 10 groups.

<!-- These counts are drift-checked against src/tools/capability-semantic-tool-catalog.ts
by src/catalog/catalog-docs.test.ts; update the catalog, not the numbers. -->

### Always-agent tools (14)

`get_task_context`, `get_task_history`, `list_documents`, `read_document`,
`list_document_revisions`, `report_progress`, `answer_status_question`,
`finish_task`, `block_task`, `request_review`, `write_document`,
`request_human_input`, `register_deliverable`, `inspect_operation_result`.

### Optional tools (23), by group

| Group | Tools |
| --- | --- |
| discovery | `search_tasks`, `list_agents`, `list_projects`, `list_goals` |
| delegation_dependencies | `create_task`, `set_dependencies` |
| governance | `list_approvals`, `request_approval`, `decide_approval`, `comment_on_approval` |
| cases | `list_cases`, `upsert_case` |
| workspace_runtime | `get_workspace_runtime`, `control_workspace_service` |
| routines | `list_routines`, `manage_routine` |
| company_skills | `list_company_skills`, `sync_company_skills` |
| secrets | `list_secret_metadata`, `read_secret_value` |
| portability_admin | `export_company`, `administer_company` |
| test_escape_hatch | `generic_api_request` |

## Descriptor shape

Each descriptor carries `operationId`, `version` (1), `title`, `description`,
input/output JSON schemas, `disposition`, an optional `optionalGroup`,
`requiredClaims`, and optionally `allowedRoles`, `taskModes`, a `sideEffectClass`
(`read`, `task_write`, `company_write`, `governance`, `workspace_control`,
`secret_read`, `admin`, `test_escape_hatch`), an `idempotency` level, `redaction`
rules, and an abstract `mockCommandMapping`.

The `mockCommandMapping` is one of `context_read`, `snapshot_read`,
`semantic_command`, `operation_result`, or `mock_extension` — describing *what*
the tool does against the mock, never *how* a transport would carry it.

## Transport neutrality

Bindings, not descriptors, produce provider shapes, both derived from the same
`visibleTools.tools` array:

- `CapabilityFakeAgentToolBinding` emits `{operationId, description, inputSchema,
  outputSchema}`.
- `CapabilityCodexToolBinding` emits `{type: "function", name, description, strict:
  true, parameters}`.

Because both bindings derive from one array, the fake-agent and Codex operation
surfaces are byte-identical. The [conformance suite](capability-eval-conformance.md)
asserts this parity (the 18/18 fake-agent/Codex operation matrix).

## Running the tests

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/tools/capability-semantic-tools.test.ts
```

The "catalog" describe asserts a unique, versioned, provider-neutral catalog and
that every optional group is present.

## Related

- [Authorization and exposure](capability-authorization-and-exposure.md)
- [Mock ControlPlanePort](capability-mock-control-plane-port.md)
- [Eval conformance](capability-eval-conformance.md)
