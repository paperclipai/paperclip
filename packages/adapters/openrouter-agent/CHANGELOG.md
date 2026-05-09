# @paperclipai/adapter-openrouter-agent

## 0.3.0

### Bug Fixes

**Tool result double-encoding** (`execute.ts`, `paperclip-tools.ts`)

All Paperclip API tool handlers previously returned `JSON.stringify(result)`,
which was then re-serialised by the transcript emit path — producing escape-quoted
blobs like `"{\"id\":\"...\"}"` in both logs and model context. Handlers now
return raw objects. A single serialisation point (`serializeForModel`) converts
any result to the string the OpenAI messages array requires, with
`pruneEmpty`-based compaction and `JSON.stringify(..., null, 2)` pretty-printing.

**Null/empty field pruning** (`tools.ts` — `pruneEmpty`)

`serializeForModel` now applies `pruneEmpty` before serialising object results.
The function recursively removes:

- `null` values
- empty arrays (after pruning children)
- empty objects (after pruning children)
- "vacuous summary" objects where every value is `0` or `"none"` — this
  specifically targets `blockerAttention` and similar all-zero count structs
  that appeared on every issue result when no blockers were present

Active blocker state (non-zero counts, non-`"none"` reason) is preserved intact.
Reduces typical issue result size ~5–6×.

**`undefined` content crash** (`tools.ts` — `serializeForModel`, `truncateForModel`)

When a tool returned an empty array (e.g. `list_comments` on a new issue),
`pruneEmpty` reduced it to `undefined`. `serializeForModel` passed that to
`truncateForModel`, which called `Buffer.from(undefined)` and threw. Fixed by:

- `JSON.stringify(...) ?? ""` guard in `serializeForModel`
- `if (!value) return ""` early return in `truncateForModel` (signature widened
  to accept `string | undefined`)

**`create_sub_issue` wrong assignee field** (`paperclip-tools.ts`)

The tool was sending `assigneeId` instead of `assigneeAgentId` to the API. The
server's `resolveCreateIssueStatusDefault` checks `assigneeAgentId` to decide
whether to default new issues to `"todo"` (assigned) or `"backlog"` (unassigned).
Because the field was silently dropped, every agent-created sub-issue landed in
`backlog` regardless of the `assignee_id` argument. Field name corrected to
`assigneeAgentId`.

## 0.2.0

### Minor Changes

- Extracted from `openrouter-local` as a standalone `openrouter_agent` adapter
  package. Adapter type key changed from `openrouter_local` to `openrouter_agent`.
  Agents on the old type must be migrated — `openrouter_local` is no longer
  registered and runs will fail with `adapter_failed / Process adapter missing
  command`.

## 0.1.0

### Minor Changes

- Initial release. Tool-aware OpenRouter adapter that runs an OpenAI-compatible
  function-calling loop on the Paperclip host. Supersedes the chat-only
  `openrouter-external` smoke-test wrapper. See
  `doc/experimental/openrouter-local-adapter_spec.md`.
