# Versioned Agent Memory — Validation Contract

- **Issue**: LET-407
- **Status**: Validation contract for future implementation. No tests are added in LET-407 itself; this doc is the binding spec the implementation issues must satisfy.
- **Companion**: [ADR](../adr/0001-versioned-agent-memory.md), [Contract](versioned-agent-memory-contract.md).

QA Validator PASS and Claude Reviewer PASS both require that the implementation issues land all tests listed below, that each test name in the table appears in CI, and that the redaction/privacy checks (§3) are exhaustive.

## 1. Test layout

| Layer | Location | Framework |
|---|---|---|
| Unit (Zod, redaction, scope resolution) | `packages/shared/src/validators/__tests__/agent_memory.test.ts`, `server/src/services/__tests__/agent_memory.unit.test.ts`, `server/src/services/__tests__/agent_memory_redaction.test.ts` | vitest |
| Capability registry | `packages/shared/src/__tests__/agent-memory-capabilities.test.ts` (new module) | vitest |
| Service / DB integration | `server/src/services/__tests__/agent_memory.service.test.ts` | vitest + ephemeral pg via existing test harness |
| Route / HTTP | `server/src/routes/__tests__/agent_memory.routes.test.ts` | vitest + supertest harness already used by `documents.routes.test.ts` |
| Migration | `packages/db/src/migrations/__tests__/0090_agent_memory.test.ts` | vitest + drizzle test runner |
| MCP tools | `packages/mcp-server/src/tools/__tests__/agent_memory.tools.test.ts` | vitest |
| Replay fixtures | `server/src/replay/__tests__/agent_memory.replay.fixture.test.ts` | vitest + golden fixtures in `__fixtures__/` |

## 2. Unit tests

### 2.1 Zod schema

| Test | Expectation |
|---|---|
| `upsertAgentMemorySchema: rejects empty key` | `key=""` → ZodError |
| `upsertAgentMemorySchema: rejects mixed-case key` | `key="FooBar"` → ZodError |
| `upsertAgentMemorySchema: requires scopeAgentId when scope=agent` | missing → ZodError |
| `upsertAgentMemorySchema: requires both ids when scope=agent_project` | missing project → ZodError |
| `upsertAgentMemorySchema: rejects scopeAgentId when scope=company` | extra ids → ZodError |
| `upsertAgentMemorySchema: requires at least valueJson or valueText` | both undefined → ZodError |
| `upsertAgentMemorySchema: confidence bounded 0..1` | `source.confidence=1.5` → ZodError |
| `memorySourceKindSchema accepts rollback` | `kind="rollback"` → OK; matches ADR §2.3 + contract §1.2 |
| `memorySourceKindSchema rejects unknown kind` | `kind="other"` → ZodError |
| `listAgentMemoryQuerySchema: asOf parses ISO timestamp` | valid → OK; invalid → ZodError |
| `rollbackAgentMemorySchema: targetRevisionId required` | missing → ZodError |
| `forgetAgentMemorySchema: reason min length 3` | `reason="ok"` → ZodError; `reason="dup"` → OK |

### 2.2 Scope resolution

`resolveMemoryReadSet({ agentId, projectId, rows })` pure function. Property tests with `fast-check`:

| Test | Expectation |
|---|---|
| `most-specific-scope-wins per key` | given rows at all three scopes for same key, only the agent_project row appears |
| `tie-broken by latest revision createdAt desc` | two rows same key & scope, newer wins |
| `keys disjoint across scopes are all returned` | union semantics, no dedupe collisions |
| `agent_only entries excluded for non-owner caller` | caller=other agent → not returned |
| `private_prompt_data summarized for Mission Control caller` | caller=mission_control → returns redacted placeholder |

### 2.3 Redaction unit tests

The `sanitizeMemoryJson` helper (contract §7.7) is a two-pass wrapper. Pass 1 is `sanitizeRecord` from `server/src/redaction.ts` and runs on object property values. Pass 2 walks the result and runs `redactSensitiveText` over every remaining string leaf so neutral-key strings and array entries cannot smuggle a raw secret through *for the patterns that `redactSensitiveText` actually matches*. The tests below pin both passes and their disjoint output arrays (`redactedPaths` for pass-1 hits, `jsonTextRedactedPaths` for pass-2 hits).

Honest coverage split (because `server/src/redaction.ts` is reused unchanged):

- **Pass 1 (`sanitizeRecord`) — two redaction branches on object property values.** Branch (a) **KEY-NAME match**: any key whose name matches the `SECRET_PAYLOAD_KEY_RE` declaration in `server/src/redaction.ts` is redacted regardless of value content. The pattern covers: `api_key`, `access_token`, `auth`, `auth_token`, `token`, `authorization`, `bearer`, `secret`, `passwd`, `password`, `credential`, `jwt`, `private_key`, `cookie`, `connectionstring` (case-insensitive, with optional separators). Branch (b) **VALUE-SHAPE match via `JWT_VALUE_RE`** (see the `JWT_VALUE_RE` declaration and the `typeof value === "string" && JWT_VALUE_RE.test(value)` branch inside `sanitizeRecord` in `server/src/redaction.ts` — citations are pinned by symbol, not by line number, so they do not rot when the file is reformatted): any string-valued object property whose value matches the anchored regex `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$` is redacted, **with no per-segment length gate**. This is more permissive than the pass-2 `COMMAND_JWT_RE` shape (which requires each segment ≥ 8 chars and uses `\b` boundaries instead of anchors). Both branches recurse into nested objects via `sanitizeValue → sanitizeRecord`; neither branch inspects array elements (those flow to pass 2). Branch (b) also requires the string to be the *entire* property value: a `"Bearer …"` or `"Authorization: …"` prefix breaks the anchored match and the value falls through to pass 2. Both pass-1 branches populate `redactedPaths` in the wrapper.
- **Pass 2 (`redactSensitiveText`) — CONTENT patterns** (see the `redactSensitiveText` function definition and the `JSON_SECRET_FIELD_TEXT_RE` / `ESCAPED_JSON_SECRET_FIELD_TEXT_RE` regex declarations it references in `server/src/redaction.ts`, plus the `redactCommandText` helper and its constituent regexes — `COMMAND_AUTHORIZATION_BEARER_RE`, `COMMAND_CLI_SECRET_FLAG_RE`, `COMMAND_ENV_ASSIGNMENT_RE`, `COMMAND_OPENAI_KEY_RE`, `COMMAND_GITHUB_TOKEN_RE`, `COMMAND_JWT_RE` — declared in `packages/adapter-utils/src/command-redaction.ts`; citations are pinned by symbol, not by line number). Runs on every string leaf that survived pass 1, including object-property strings that did not match either pass-1 branch and every array element. The strings actually rewritten in pass 2 are limited to:
  1. JSON secret-field snippets embedded in a string, e.g. `'... "api_key":"sk-foo" ...'` (matches `JSON_SECRET_FIELD_TEXT_RE` / `ESCAPED_JSON_SECRET_FIELD_TEXT_RE` over the *string contents*, not the object key).
  2. `Authorization: Bearer …` headers. (`COMMAND_AUTHORIZATION_BEARER_RE` requires the literal `Authorization:` prefix; bare opaque `Bearer <token>` strings are NOT covered by this shape and are only rewritten when the `<token>` itself separately matches shape (5) `sk-…`, shape (6) `ghp_/gho_/ghu_/ghs_/ghr_`, shape (7) dotted JWT, shape (3) `--flag=value`, shape (4) `ENV=value`, or shape (1) inline-JSON snippet. See the documented gap row below.)
  3. Long CLI secret options of the form `--api-key=…`, `--token …`, etc.
  4. Env-style secret assignments such as `OPENAI_API_KEY=sk-…`, `GITHUB_TOKEN=ghp_…`.
  5. OpenAI-style `sk-…` keys (length-gated).
  6. GitHub tokens `ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `ghr_…`.
  7. Three- or four-part dotted JWT shapes via `COMMAND_JWT_RE` — `{8,}` per-segment length gate, `\b…\b` boundary (not anchored). Inside `sanitizeMemoryJson` this shape fires for **array elements** and for **prefixed strings** (e.g. `"Bearer eyJ….eyJ….sig…"` whose `Bearer ` prefix broke pass-1 branch (b)). Pure dotted-JWT object-property values like `{notes:"eyJ….eyJ….sig…"}` are caught by pass-1 branch (b) instead and recorded under `redactedPaths`, never under `jsonTextRedactedPaths`.

Bare value strings that are not in one of those seven shapes (for example a raw cookie value `"abc123def"` under `{notes:"abc123def"}` — no `Cookie:` prefix, no `=`) are **not** rewritten by pass 2 because `redactSensitiveText` is the canonical text scrubber and does not pattern-match on value content alone. The validation row that previously asserted "12 patterns under NEUTRAL keys are all rewritten in pass 2" was over-claiming and has been removed; the tests below assert only the seven shapes above for neutral-key/array content, and shape (7) under neutral object keys is attributed to pass-1 branch (b) — not pass 2.

| Test | Expectation |
|---|---|
| `sanitizeRecord (pass 1): api_key key is redacted` | `{api_key:"sk-..."}` → `{api_key:"***REDACTED***"}` (redaction.ts behavior; reused unchanged) |
| `sanitizeMemoryJson: top-level api_key path recorded under redactedPaths` | `{api_key:"sk-..."}` → `{sanitized:{api_key:"***REDACTED***"}, redactedPaths:["api_key"], jsonTextRedactedPaths:[]}` |
| `sanitizeMemoryJson: nested authToken path recorded under redactedPaths` | `{cfg:{authToken:"x"}}` → `redactedPaths:["cfg.authToken"], jsonTextRedactedPaths:[]` |
| `sanitizeMemoryJson: array element with sk-live-... rewritten and recorded under jsonTextRedactedPaths` | `{tokens:["plain","sk-live-AAAAAAAAAAAA"]}` → `sanitized.tokens[1] = "***REDACTED***"`, `redactedPaths:[]`, `jsonTextRedactedPaths:["tokens[1]"]` (the key `tokens` is neutral, so pass 1 does nothing; pass 2 rewrites the `sk-…` content) |
| `sanitizeMemoryJson: array element with ghp_... rewritten and recorded under jsonTextRedactedPaths` | `{tokens:["plain","ghp_<synthetic-fixture-built-in-test>"]}` → `jsonTextRedactedPaths:["tokens[1]"]` |
| `sanitizeMemoryJson: neutral-key string with bearer header rewritten and recorded under jsonTextRedactedPaths` | `{notes:"Authorization: Bearer eyJabc.def.ghi"}` → `sanitized.notes` no longer contains the raw token; `jsonTextRedactedPaths:["notes"]`, `redactedPaths:[]` |
| `sanitizeMemoryJson: neutral-key string with env-style assignment rewritten` | `{notes:"OPENAI_API_KEY=sk-live-AAAAAAAAAAAA"}` → `sanitized.notes` no longer contains the raw key; `jsonTextRedactedPaths:["notes"]` |
| `sanitizeMemoryJson: neutral-key string with embedded JSON snippet rewritten` | `{notes:"resp body: {\"api_key\":\"sk-foo\"}"}` → `sanitized.notes` replaces the snippet value; `jsonTextRedactedPaths:["notes"]` (matches `JSON_SECRET_FIELD_TEXT_RE` over the string contents, even though the object key is neutral) |
| `sanitizeMemoryJson: neutral-key string with bare dotted-JWT shape is redacted by pass-1 branch (b), not pass 2` | `{notes:"eyJhbGciOi.eyJpYXQiOj.signature"}` → `sanitized.notes = "***REDACTED***"` (matches the anchored `JWT_VALUE_RE` declaration in `server/src/redaction.ts`, fired by the `typeof value === "string" && JWT_VALUE_RE.test(value)` branch inside `sanitizeRecord`, with no per-segment length gate; the citation is pinned by symbol so it does not rot when the file is reformatted); `redactedPaths:["notes"]`, `jsonTextRedactedPaths:[]`. The shorter fixture `{notes:"eyJabc.def.ghi"}` (segments 6/3/3 chars) is also redacted here for the same reason; pass-1 branch (b) has no `{8,}` gate. |
| `sanitizeMemoryJson: array element with dotted-JWT shape (segments ≥ 8 chars) rewritten by pass 2` | `{tokens:["plain","eyJhbGciOi.eyJpYXQiOj.signature01"]}` → `sanitized.tokens[1] = "***REDACTED***"`; `redactedPaths:[]`, `jsonTextRedactedPaths:["tokens[1]"]`. Pass 1 does not inspect array elements; pass 2 matches `COMMAND_JWT_RE`. The shorter array-element fixture `{tokens:["plain","eyJabc.def.ghi"]}` (segments 6/3/3) is NOT redacted in either pass — it fails the `{8,}` gate and there is no pass-1 array-element check. |
| `sanitizeMemoryJson: prefixed dotted-JWT string under neutral key rewritten by pass 2` | `{notes:"Bearer eyJhbGciOi.eyJpYXQiOj.signature01"}` → `sanitized.notes` no longer contains the raw token; `redactedPaths:[]`, `jsonTextRedactedPaths:["notes"]`. Pass-1 branch (b) requires anchored `^…$` and is broken by the `Bearer ` prefix; pass 2 matches `COMMAND_JWT_RE` with `\b` boundary. |
| `sanitizeMemoryJson: deeply nested neutral-key string rewritten with full dot-path` | `{run:{output:{lines:["log","sk-live-AAAAAAAAAAAA"]}}}` → `jsonTextRedactedPaths:["run.output.lines[1]"]` |
| `sanitizeMemoryJson: empty arrays for clean input` | `{foo:"bar", n:1, deep:{x:"y"}}` → `redactedPaths:[], jsonTextRedactedPaths:[]`, sanitized is structurally equal to input |
| `sanitizeMemoryJson: REDACTED_EVENT_VALUE leaves are NOT re-rewritten` | pass-2 walk does not record a leaf whose value was already `"***REDACTED***"` from pass 1 |
| `sanitizeMemoryJson: bare value matching pass-1 key category but with neutral key is preserved (documented gap)` | Both `{notes:"my-cookie-value-abc123"}` AND `{notes:"Bearer abc123def"}` (bare opaque bearer without the `Authorization:` prefix and without a token-shape that matches another rule) → `sanitized.notes` unchanged; `redactedPaths:[], jsonTextRedactedPaths:[]`. This asserts the honest scope of pass 2: bare value content for KEY-NAME-only categories (`cookie`, `credential`, `connectionstring`, plain `password`, plain `secret`, plain `private_key`) AND bare opaque `Bearer <opaque-token>` strings (where `<opaque-token>` is not a dotted JWT / `sk-…` / `ghp_…` / env-assignment / CLI-flag / inline-JSON snippet) are not rewritten unless they also match one of the seven content shapes listed above. The acceptance gate "no raw secret persisted" still holds because (a) callers who place such values under matching keys hit pass 1, (b) callers who pass a full `Authorization: Bearer …` header hit pass 2 shape (2), (c) callers who pass a dotted JWT token hit pass 2 shape (7), and (d) the no-raw-secret promise of LET-407 binds the seven content shapes above and the full KEY-NAME category list of pass 1. LET-407-A may either keep this scope by surfacing the gap in MCP error messages, or — only if the product requirement truly is to catch bare opaque `Bearer <token>` — add a new memory-specific matcher inside `server/src/services/agent_memory_redaction.ts` with explicit tests; it must NOT claim the unchanged `redactSensitiveText` helper already covers bare bearer strings. |
| `sanitizeMemoryJson: 15 KEY-NAME categories under matching keys all rewritten in pass 1` | for each of `api_key, access_token, auth, auth_token, token, authorization, bearer, secret, passwd, password, credential, jwt, private_key, cookie, connectionstring` placed under the matching key, the value is scrubbed; each path appears once in `redactedPaths`. |
| `sanitizeMemoryJson: 6 CONTENT shapes under neutral object keys all rewritten in pass 2` | for each content shape — (1) inline-JSON secret-field snippet, (2) `Authorization: Bearer …`, (3) `--api-key=…` CLI flag, (4) `OPENAI_API_KEY=…` env assignment, (5) `sk-…` key, (6) `ghp_…` GitHub token — placed under key `notes`, the value is scrubbed by pass 2; each path appears once in `jsonTextRedactedPaths`, `redactedPaths` stays empty. Shape (7) dotted JWT is intentionally excluded here because a bare dotted-JWT-shaped string under any object key is caught by pass-1 branch (b) (anchored `JWT_VALUE_RE`) before pass 2 runs; see the dedicated row above. |
| `sanitizeMemoryJson: 7 CONTENT shapes inside array elements all rewritten in pass 2` | for each of the seven shapes — (1) inline-JSON snippet, (2) `Authorization: Bearer …`, (3) `--api-key=…`, (4) `OPENAI_API_KEY=…`, (5) `sk-…`, (6) `ghp_…`, (7) dotted JWT with segments ≥ 8 chars — placed as a single element of `{notesList: [...]}`, the value is scrubbed; each path appears once in `jsonTextRedactedPaths` as `notesList[0]`. Pass 1 does not inspect array elements, so shape (7) lands in pass 2 here. |
| `redactSensitiveText: Authorization bearer header is scrubbed` | `"Authorization: Bearer eyJabc.def.ghi"` → contains `***REDACTED***` (matches `COMMAND_AUTHORIZATION_BEARER_RE` literal-prefix shape) |
| `redactSensitiveText: bare dotted-JWT token is scrubbed even without Authorization: prefix` | `"Bearer eyJhbGciOi.eyJpYXQiOj.signature01"` → contains `***REDACTED***`. Each of the three dotted segments (`eyJhbGciOi` 10 chars, `eyJpYXQiOj` 10 chars, `signature01` 11 chars) satisfies the source `COMMAND_JWT_RE` `{8,}` per-segment length gate in `packages/adapter-utils/src/command-redaction.ts:10-11`. Asserts the redaction fires here because the token matches the dotted-JWT shape, NOT because of bare `Bearer …` coverage. A bare opaque bearer like `"Bearer abc123def"` (without a JWT-shaped token) is NOT scrubbed by `redactSensitiveText`; see the documented gap row above. Counter-example fixture: `"Bearer eyJabc.def.ghi"` (segments 6/3/3 chars) does NOT contain `***REDACTED***` because the segments are shorter than the `{8,}` gate and there is no bare-bearer matcher. |
| `sanitizeTextWithFlag: returns redacted=true when text changed` | input differs from output → `redacted:true` |
| `acknowledgeRedaction=false 422s when redactedPaths is non-empty` | service returns `{code:"REDACTION_REQUIRED", redactedPaths:["api_key"], jsonTextRedactedPaths:[], textRedactionApplied:false}` |
| `acknowledgeRedaction=false 422s when jsonTextRedactedPaths is non-empty even with empty redactedPaths` | service returns `{code:"REDACTION_REQUIRED", redactedPaths:[], jsonTextRedactedPaths:["notes"], textRedactionApplied:false}` |
| `acknowledgeRedaction=false 422s when textRedactionApplied is true with both path arrays empty` | service returns `{code:"REDACTION_REQUIRED", redactedPaths:[], jsonTextRedactedPaths:[], textRedactionApplied:true}` |
| `acknowledgeRedaction=true persists sanitized copy only` | DB row contains `***REDACTED***`, never the original secret-shaped string |
| `persisted redaction row carries disjoint path arrays` | `agent_memory_revisions.redaction.keyRedactedPaths` and `.jsonTextRedactedPaths` together cover every redaction event, with no overlap |
| `server/src/redaction.ts is unchanged` | git diff over the implementation PR shows zero edits to that file |
| `private_prompt_data is opaque to non-owner` | service.list as other agent → `valueText:null, valueJson:null, redactedSummary:"<private prompt data — N chars>"` |

### 2.4 Capability registry (new module `packages/shared/src/agent-memory-capabilities.ts`)

The registry is the binding source of truth for which roles may invoke which memory operation. Tests pin contract §6.2 and the wiring described in §6.1.

| Test | Expectation |
|---|---|
| `MEMORY_CAPABILITIES tuple matches contract §6.2 exactly` | equality against the literal list (length + members), so an out-of-sync edit fails CI loudly |
| `MEMORY_CAPABILITY_DEFAULT_HOLDERS keys cover every capability` | one entry per capability, no extras |
| `MEMORY_CAPABILITY_DEFAULT_HOLDERS values are valid AGENT_ROLES or the special "user_admin" / "every_agent_in_company" sentinels` | every holder string is either re-imported from existing `AGENT_ROLES` or one of the two sentinels; no free-form strings |
| `memory.forget.hard is restricted to the human admin sentinel` | `MEMORY_CAPABILITY_DEFAULT_HOLDERS["memory.forget.hard"]` does NOT include any agent role; only `"user_admin"` |
| `isMemoryCapability accepts every member and rejects unknown values` | guard correctness |
| `packages/shared/src/index.ts re-exports MEMORY_CAPABILITIES, MEMORY_CAPABILITY_DEFAULT_HOLDERS, isMemoryCapability, type MemoryCapability` | grep / import test passes |
| `packages/shared/src/agent-capabilities.ts is NOT modified by LET-407-B` | git diff over the implementation PR shows zero edits to that file |
| `packages/shared/src/capability-apply.ts is NOT modified by LET-407-B` | git diff over the implementation PR shows zero edits to that file |

## 3. Service / DB integration tests

Use the existing test pg harness (same one used by `documents.service.test.ts`).

### 3.1 Happy path

- `upsert on a brand-new key creates revision 1 (NOT 2) — parent row written with latest_revision_number=0 in the same tx, then advanced to 1`
- `agent_memory_latest_revision_invariant_chk: a parent row inserted with latest_revision_number=1 and latest_revision_id NULL fails the CHECK` (raw INSERT bypassing the service)
- `upsert creates revision 1, materializes latest_* columns`
- `second upsert with baseRevisionId=rev1.id creates revision 2 and links supersedesRevisionId`
- `second upsert without baseRevisionId still works (no-OCC mode)`
- `second upsert with stale baseRevisionId 409s`
- `null-safe scope uniqueness: company scope, second insert with same (companyId, key) and both scope ids NULL → service treats as update; raw INSERT bypassing the service hits 23505 on agent_memory_scope_company_key_uq`
- `null-safe scope uniqueness: agent scope, second insert with same (companyId, scopeAgentId, key) and scopeProjectId NULL → service treats as update; raw INSERT hits 23505 on agent_memory_scope_agent_key_uq`
- `null-safe scope uniqueness: agent_project scope, second insert with same (companyId, scopeAgentId, scopeProjectId, key) → service treats as update; raw INSERT hits 23505 on agent_memory_scope_agent_project_key_uq`
- `scope isolation: a company-scope row and an agent-scope row with the same key coexist (different partial indexes)`
- `scope isolation: an agent-scope row and an agent_project-scope row with the same key and same agentId coexist`

### 3.2 Rollback

- `rollback creates new revision with source.kind="rollback"`
- `rollback preserves full chain (revision count grows by 1)`
- `rollback target from a different memoryId → 400`
- `rollback updates latest_* columns to rolled-back values`
- `rollback emits activity_log action="memory.rollback" with from/to revision ids`

### 3.3 Expiry

- `sweepExpired marks status=expired for rows past expires_at`
- `sweepExpired is idempotent (no re-emit for already-expired)`
- `default list omits expired rows`
- `includeExpired=true returns expired rows with status field`

### 3.4 Privacy / redaction (acceptance gate)

- `golden test (matching-key, pass 1): the 15 KEY-NAME categories listed in §2.3 (api_key, access_token, auth, auth_token, token, authorization, bearer, secret, passwd, password, credential, jwt, private_key, cookie, connectionstring) placed under matching keys all end up scrubbed; persisted row has the path under keyRedactedPaths and no raw value in any column`
- `golden test (neutral object key, pass 1 branch (b)): a bare dotted-JWT-shaped string under {notes:"eyJhbGciOi.eyJpYXQiOj.signature"} (and the shorter 6/3/3-segment fixture {notes:"eyJabc.def.ghi"}) is scrubbed by pass-1 branch (b) via JWT_VALUE_RE; persisted row has the path under keyRedactedPaths (NOT jsonTextRedactedPaths) and no raw value in any column. Asserts the documented pass-1 vs pass-2 split for shape (7).`
- `golden test (neutral object key, pass 2): the 6 pass-2-eligible CONTENT shapes listed in §2.3 (inline-JSON snippet, Authorization bearer header, --flag=value CLI option, ENV_VAR=value assignment, sk-* key, ghp_/gho_/ghu_/ghs_/ghr_ GitHub token) placed under a neutral key (notes) all end up scrubbed by pass 2; persisted row has the path under jsonTextRedactedPaths and no raw value in any column. Shape (7) dotted JWT is excluded here per the row above; the prefixed form (Bearer eyJ….eyJ….sig…) does land in pass 2 and is covered by shape (2)/(7)-via-prefix in the array test below.`
- `golden test (array element, pass 2): all 7 CONTENT shapes from §2.3 (including shape (7) dotted JWT with segments ≥ 8 chars, since pass 1 does not inspect array elements) placed as elements of a neutral array (notesList) all end up scrubbed by pass 2; persisted row records each "notesList[i]" under jsonTextRedactedPaths`
- `documented gap: a bare value matching ONLY a pass-1 KEY-NAME category (e.g. "abc123def" under {notes:"abc123def"} for cookie/credential/connectionstring) is intentionally not rewritten in either pass; the test asserts no false-positive redaction. The no-raw-secret acceptance gate of LET-407 binds the 15 KEY-NAME categories (under matching keys) and the 7 CONTENT shapes (anywhere); bare value scrubbing for KEY-NAME-only categories is out of scope.`
- `value_text containing each pattern is scrubbed`
- `service log line for memory.create does NOT contain the original secret value, even for neutral-key inputs` (use a log-capture spy)
- `Mission Control view for private_prompt_data:true returns summary only`
- `replay output for private_prompt_data:true returns null + marker`
- `screenshot fixtures in docs/pr-screenshots/let-407*/ use synthetic data (snapshot check by file existence + content regex against the known synthetic markers)`

### 3.5 Cross-company isolation

- `upsert with mismatched companyId in path vs body → 403`
- `list with companyId=A cannot return rows from company B (DB query confirms WHERE filter)`

### 3.6 Forget

- `soft forget: status=forgotten, forgottenAt set, latest_value_* nulled, revisions retained, log emitted with reason`
- `hard forget: revisions deleted, parent deleted, log emitted with revisionCount`
- `hard forget without memory.forget.hard capability → 403`

### 3.7 Replay × forget interaction

- `soft-forgotten entry where forgottenAt > asOf: replay returns value=null with forgottenLater=true` (contract §4.6)
- `soft-forgotten entry where forgottenAt <= asOf: replay omits the entry` (the agent did not see it at run time)
- `hard-forgotten entry: replay does NOT include the entry and does NOT emit a forgottenLater=true tombstone; activity_log row with action="memory.forget" and details.hardDelete=true is the sole audit artifact`
- `audit timeline query /api/runs/:runId/audit returns the memory.forget hardDelete row even after replay omits the entry`

## 4. Route / HTTP tests

| Test | Expectation |
|---|---|
| `POST /memory: validates body, returns 201 with row + latest revision id` | 201 |
| `POST /memory: redaction without acknowledge → 422 with redactedPaths + jsonTextRedactedPaths + textRedactionApplied` | 422 body matches contract §4.1 step 5 / §7.2 |
| `POST /memory: neutral-key string with Authorization bearer header → 422 with jsonTextRedactedPaths=["notes"]` | body `{notes:"Authorization: Bearer abc123def"}`; pass-2 shape (2) literal-prefix matcher fires; 422 with `jsonTextRedactedPaths=["notes"]`; raw token never reaches DB or log |
| `POST /memory: neutral object-key string with bare dotted-JWT token → 422 with redactedPaths=["notes"]` | body `{notes:"eyJhbGciOi.eyJpYXQiOj.signature01"}`; pass-1 branch (b) `JWT_VALUE_RE` (anchored, no segment-length gate) fires before pass 2; 422 with `redactedPaths=["notes"]`, `jsonTextRedactedPaths=[]`; raw token never reaches DB or log. Asserts the documented split: under object keys shape (7) is pass 1, not pass 2. |
| `POST /memory: neutral-key string with prefixed dotted-JWT token → 422 with jsonTextRedactedPaths=["notes"]` | body `{notes:"Bearer eyJhbGciOi.eyJpYXQiOj.signature01"}` (the `Bearer ` prefix breaks the anchored pass-1 `^…$` match); pass-2 `COMMAND_JWT_RE` matches with `\b` boundary; 422 with `redactedPaths=[]`, `jsonTextRedactedPaths=["notes"]`; raw token never reaches DB or log |
| `POST /memory: array element with dotted-JWT token → 422 with jsonTextRedactedPaths=["notesList[0]"]` | body `{notesList:["eyJhbGciOi.eyJpYXQiOj.signature01"]}`; pass 1 does not inspect array elements; pass-2 shape (7) matcher fires; 422 with `redactedPaths=[]`, `jsonTextRedactedPaths=["notesList[0]"]` |
| `POST /memory: neutral-key string with bare opaque Bearer string is NOT redacted (documented gap)` | body `{notes:"Bearer abc123def"}` (no Authorization: prefix, token not JWT/sk-/ghp_ shape); 201 with `redactedPaths:[], jsonTextRedactedPaths:[]`; asserts pass 2 does not over-claim bare-bearer coverage. LET-407-A may close this gap with a memory-specific matcher or surface it in MCP errors per validation §2.3. |
| `POST /memory: array element with sk-live-... → 422 with jsonTextRedactedPaths=["tokens[1]"]` | 422; raw token never reaches DB or log |
| `GET /memory: pagination via cursor` | stable order, no duplicate rows |
| `GET /memory: asOf={t} returns latest revision at-or-before t for each entry` | replay semantics |
| `GET /memory/:id/revisions: returns descending revisionNumber` | order |
| `GET /memory/:id/diff?from=&to=: returns unifiedDiff for text-only entries` | string diff |
| `GET /memory/:id/diff?from=&to=: returns RFC6902 jsonPatch for JSON entries` | array of ops |
| `GET /memory/:id/diff: unifiedDiff payload over DIFF_MAX_BYTES (100 KiB) is truncated with truncated.reason="size_cap"` | 200 with `truncated` field; body size ≤ cap; matches the shared DIFF_MAX_BYTES rule in contract §4.2 that the MCP wrapper in §5 reuses |
| `GET /memory/:id/diff: jsonPatch payload over DIFF_MAX_BYTES is truncated; dropped op count reported in truncated` | response describes truncation; no silent drop |
| `GET /memory/:id/diff: diff output runs through redactSensitiveText so secrets that landed in revisions are not exposed via diff` | redacted markers in output |
| `POST /memory/:id/rollback: requires capability memory.rollback` | 403 without |
| `POST /memory/:id/forget: requires capability memory.forget` | 403 without |
| `cross-company path mismatch → 403` | hard guard |

## 5. Migration tests

| Test | Expectation |
|---|---|
| `0090 applies on a fresh db` | tables exist with expected columns/indexes |
| `0090 is idempotent on re-apply (uses IF NOT EXISTS)` | no error |
| `down/up replay: applying 0090 over an existing db with seed agents and companies preserves referential integrity` | FK constraints fire |
| `default values: visibility="normal", status="active", private_prompt_data=false, redaction=default jsonb` | inserted row reflects defaults |
| `partial unique index agent_memory_scope_company_key_uq prevents duplicate company-scope (companyId, key) even though scope_agent_id/scope_project_id are NULL` | second insert 23505 |
| `partial unique index agent_memory_scope_agent_key_uq prevents duplicate agent-scope (companyId, scopeAgentId, key) with scope_project_id NULL` | second insert 23505 |
| `partial unique index agent_memory_scope_agent_project_key_uq prevents duplicate agent_project-scope (companyId, scopeAgentId, scopeProjectId, key)` | second insert 23505 |
| `partial indexes do not cross-collide: company-scope and agent-scope rows with the same key coexist` | both inserts succeed |
| `CHECK agent_memory_scope_shape_chk rejects scope=agent with scope_agent_id NULL` | insert fails with 23514 |
| `CHECK agent_memory_scope_shape_chk rejects scope=company with non-NULL scope_agent_id or scope_project_id` | insert fails with 23514 |
| `CHECK agent_memory_status_chk rejects status='deleted'` | insert fails with 23514 |
| `CHECK agent_memory_visibility_chk rejects visibility='public'` | insert fails with 23514 |
| `CHECK agent_memory_latest_revision_invariant_chk rejects (latest_revision_number=1 AND latest_revision_id IS NULL)` | insert fails with 23514 |
| `CHECK agent_memory_latest_revision_invariant_chk accepts (latest_revision_number=0 AND latest_revision_id IS NULL AND latest_value_* IS NULL)` | bootstrap insert succeeds inside the service transaction |
| `FK scope_project_id → projects(id) ON DELETE CASCADE: deleting a project removes its agent_project memory rows` | rows deleted; revisions cascade via memory_id FK |
| `FK scope_agent_id → agents(id) ON DELETE CASCADE: deleting an agent removes its agent-scope memory rows` | rows deleted |

## 6. MCP tool tests

| Test | Expectation |
|---|---|
| `paperclipUpsertAgentMemory: success path proxies through service` | revision created |
| `paperclipUpsertAgentMemory: 422 response on pass-1 redaction shows redactedPaths` | structured error returned to MCP caller with `redactedPaths` populated (either branch (a) key-name match or branch (b) `JWT_VALUE_RE` value-shape match) and `jsonTextRedactedPaths` empty |
| `paperclipUpsertAgentMemory: 422 response on neutral-key/array string redaction shows jsonTextRedactedPaths` | structured error returned to MCP caller with `jsonTextRedactedPaths` populated and `redactedPaths` empty |
| `paperclipDiffAgentMemoryRevisions: text diff payload bounded to 100KB` | larger diffs truncated with marker |
| `paperclipRollbackAgentMemory: capability denied → tool returns ERROR with code FORBIDDEN` | not unhandled throw |
| `paperclipForgetAgentMemory: hardDelete=true rejected for agent callers (only humans)` | 403 |

## 7. Replay fixtures

Golden fixtures in `server/src/replay/__fixtures__/agent_memory/`:

- `seed.json`: 6 memory entries spanning all three scopes, with 1–4 revisions each, one with redacted secrets, one with `private_prompt_data:true`, one expired.
- `runs.json`: 3 heartbeat run records that read memory at distinct timestamps.
- `expected/run-1.json` … `run-3.json`: the exact list of memory entries each run should see at `asOf = run.startedAt`.

| Test | Expectation |
|---|---|
| `replay run-1 returns exactly the expected set` | byte-equal to golden |
| `replay run-2 (after a rollback) returns the rolled-back value` | not the original |
| `replay run-3 (after expiry) does not include the expired row` | absent |
| `golden update guard: snapshot mismatches fail loudly with a clear message` | no silent overwrites |

## 8. Performance / capacity (advisory; non-blocking)

Not gating PASS but recorded for the implementation issue:

- p50 write latency < 25ms on the test harness (single-row insert + revision insert in one tx).
- `list` with 1000 entries paginated at limit=100 < 80ms p50.
- `diff` between two 50KB JSON values < 150ms p50.

If any metric is breached by >2x at implementation time, file a follow-up issue rather than blocking the lane.

## 9. CI wiring

Implementation issues must:

- Add `agent_memory` test suites to the existing vitest project config so they run under `pnpm test`.
- Add a CI job marker `agent-memory` so the validator can confirm presence (e.g., a tag in vitest reporter output the validator script looks for).
- Add the golden replay fixture path to `.gitattributes` with `binary` so future diffs don't churn the review.

## 10. Acceptance summary (for QA Validator / Claude Reviewer)

PASS requires all of:

1. Every test in §2–§7 of this contract is present and green.
2. `pnpm typecheck` clean across `server/`, `packages/shared/`, `packages/mcp-server/`, `packages/db/`, and `ui/` once each implementation lane lands.
3. Migration 0090 applies cleanly on a fresh db and the test in §5 passes.
4. Manual screenshot of Mission Control memory panel does not show real customer data (synthetic seed only). Stored under `docs/pr-screenshots/let-407-c/`.
5. Reviewer confirms the redaction acceptance gate (§3.4) is exhaustive against the secret-pattern list in `server/src/redaction.ts`.
6. ADR open questions §5 have explicit reviewer answers recorded as comments on the implementation PRs (not on LET-407).
