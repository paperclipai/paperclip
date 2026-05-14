# `paperclip-plugin-slack` In-Tree Fork — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-27-paperclip-plugin-slack-fork-design.md`

**Goal:** Replace the upstream npm `paperclip-plugin-slack@2.0.7` with an in-tree workspace fork that declares 19 manifest tools (8 existing orchestration handlers + 11 new Slack-API tools) so agents can act on Slack directly, while preserving all current webhook/notification behavior and reusing the existing plugin DB row, secrets, and config.

**Architecture:** New workspace package at `packages/plugins/paperclip-plugin-slack/`, source recovered from the published `dist/` and converted back to TypeScript. The fork keeps `pluginKey: "paperclip-plugin-slack"` so the existing DB row carries over. The npm package is removed from `BUNDLED_PLUGINS` so auto-install stops on each startup; the workspace copy takes its place. Tool handlers wrap an extended `slack-api.ts` with TDD coverage.

**Tech Stack:** TypeScript, `@paperclipai/plugin-sdk` (workspace:*), `@paperclipai/shared` (workspace:*), vitest. Plugin SDK v1 (`apiVersion: 1`).

**Owner-side ops note:** This plan does NOT auto-commit. The repo owner's CLAUDE.md requires explicit commit approval. Each task ends with a "Stage" step listing the files; the executor should run `git add` and `git status`, then pause for the owner to approve before `git commit`. Treat task completion = changes staged and verified, not pushed.

---

## File map (locked before tasks)

**Created:**
- `packages/plugins/paperclip-plugin-slack/package.json`
- `packages/plugins/paperclip-plugin-slack/tsconfig.json`
- `packages/plugins/paperclip-plugin-slack/vitest.config.ts`
- `packages/plugins/paperclip-plugin-slack/README.md`
- `packages/plugins/paperclip-plugin-slack/src/index.ts`
- `packages/plugins/paperclip-plugin-slack/src/manifest.ts`
- `packages/plugins/paperclip-plugin-slack/src/worker.ts`
- `packages/plugins/paperclip-plugin-slack/src/slack-api.ts`
- `packages/plugins/paperclip-plugin-slack/src/acp-bridge.ts`
- `packages/plugins/paperclip-plugin-slack/src/custom-commands.ts`
- `packages/plugins/paperclip-plugin-slack/src/media-pipeline.ts`
- `packages/plugins/paperclip-plugin-slack/src/proactive-suggestions.ts`
- `packages/plugins/paperclip-plugin-slack/src/formatters.ts`
- `packages/plugins/paperclip-plugin-slack/src/adapter.ts`
- `packages/plugins/paperclip-plugin-slack/src/constants.ts`
- `packages/plugins/paperclip-plugin-slack/src/types.ts`
- `packages/plugins/paperclip-plugin-slack/src/tools.ts` *(new — tool handler bindings, kept separate from worker.ts to keep that file focused on lifecycle)*
- `packages/plugins/paperclip-plugin-slack/src/__tests__/slack-api.test.ts`
- `packages/plugins/paperclip-plugin-slack/src/__tests__/tools.test.ts`

**Modified:**
- `server/src/index.ts` (drop `"paperclip-plugin-slack"` from `BUNDLED_PLUGINS` array, line 67)

**Note on porting:** `acp-bridge.ts`, `custom-commands.ts`, `media-pipeline.ts`, `proactive-suggestions.ts`, `formatters.ts`, `adapter.ts`, `constants.ts` are mechanical ports of the published `dist/*.js` (location: `~/.paperclip/plugins/node_modules/paperclip-plugin-slack/dist/`) converted back to TypeScript. Conversion rules: `.js` extensions in import paths preserved (ESM); `JSDoc @type {…}` annotations replaced with TS types where present; otherwise byte-equivalent. These are not creative tasks — show file via `Read`, write to `src/`, run `pnpm typecheck` to validate.

---

## Task 1: Workspace package skeleton

**Files:**
- Create: `packages/plugins/paperclip-plugin-slack/package.json`
- Create: `packages/plugins/paperclip-plugin-slack/tsconfig.json`
- Create: `packages/plugins/paperclip-plugin-slack/vitest.config.ts`
- Create: `packages/plugins/paperclip-plugin-slack/README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "paperclip-plugin-slack",
  "version": "2.1.0",
  "description": "In-tree fork of paperclip-plugin-slack with agent-callable Slack API tools",
  "type": "module",
  "private": true,
  "main": "./dist/index.js",
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "scripts": {
    "prebuild": "node ../../../scripts/ensure-plugin-build-deps.mjs",
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk build && tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*",
    "@paperclipai/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3",
    "vitest": "^3.0.0"
  },
  "files": ["dist/"]
}
```

Name is `paperclip-plugin-slack` (not namespaced) — matches the upstream npm package name, so the host loader resolves bundled-plugin entries to this workspace copy.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2023"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create `README.md`**

```markdown
# paperclip-plugin-slack (in-tree fork)

In-tree fork of the upstream `paperclip-plugin-slack` npm package with two changes:

1. Adds `manifest.tools[]` so existing orchestration handlers (`escalate_to_human`,
   `handoff_to_agent`, `discuss_with_agent`, `process_media`, `register_command`,
   `register_watch`, `remove_watch`, `list_watch_templates`) actually reach agents.
2. Adds eleven Slack-API tools so agents can post messages, list channels, send
   DMs, search, react, upload files, and look up users.

Plugin key (`paperclip-plugin-slack`) and config schema are preserved — the
existing instance config and secrets carry over with no migration.

See `docs/superpowers/specs/2026-04-27-paperclip-plugin-slack-fork-design.md`.
```

- [ ] **Step 5: Verify pnpm picks up the new workspace package**

Run: `pnpm install --filter paperclip-plugin-slack`
Expected: package recognized, dependencies resolved, exit code 0.

`pnpm-workspace.yaml` already includes `packages/plugins/*` so no edit is needed.

- [ ] **Step 6: Run typecheck on the empty skeleton**

Run: `pnpm --filter paperclip-plugin-slack typecheck`
Expected: error — `Cannot find module 'src'` or `No inputs were found`. That's fine — we have no source yet.

- [ ] **Step 7: Stage**

```bash
git add packages/plugins/paperclip-plugin-slack/package.json \
        packages/plugins/paperclip-plugin-slack/tsconfig.json \
        packages/plugins/paperclip-plugin-slack/vitest.config.ts \
        packages/plugins/paperclip-plugin-slack/README.md
git status
```

Pause for owner approval before commit. Suggested commit message: `feat(plugin-slack): scaffold in-tree fork`.

---

## Task 2: Port unchanged modules (constants, types, formatters, adapter)

**Files:**
- Create: `packages/plugins/paperclip-plugin-slack/src/constants.ts` (port of `dist/constants.js`)
- Create: `packages/plugins/paperclip-plugin-slack/src/types.ts` (port of `dist/types.js`)
- Create: `packages/plugins/paperclip-plugin-slack/src/formatters.ts` (port of `dist/formatters.js`)
- Create: `packages/plugins/paperclip-plugin-slack/src/adapter.ts` (port of `dist/adapter.js`)

These four modules have no behavior changes. Mechanical TS conversion of the published `dist/*.js`.

- [ ] **Step 1: Read source files from the upstream install**

```
~/.paperclip/plugins/node_modules/paperclip-plugin-slack/dist/constants.js
~/.paperclip/plugins/node_modules/paperclip-plugin-slack/dist/types.js
~/.paperclip/plugins/node_modules/paperclip-plugin-slack/dist/formatters.js
~/.paperclip/plugins/node_modules/paperclip-plugin-slack/dist/adapter.js
```

Use the Read tool on each.

- [ ] **Step 2: Write `src/constants.ts`**

Port the JS verbatim, then:
- Replace `export const DEFAULT_CONFIG = {...}` annotations with `export const DEFAULT_CONFIG: SlackPluginConfig = {...}` (importing from `./types.js`).
- Add new field `slackUserTokenRef: ""` to `DEFAULT_CONFIG` for the optional user token.

- [ ] **Step 3: Write `src/types.ts`**

Port verbatim. Add new field to `SlackPluginConfig`:

```ts
/** Optional secret reference to a Slack user token (xoxp-...) used by search.messages. */
slackUserTokenRef?: string;
```

- [ ] **Step 4: Write `src/formatters.ts` and `src/adapter.ts` verbatim**

Mechanical port — preserve all imports (with `.js` extensions for ESM), function signatures, and bodies.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter paperclip-plugin-slack typecheck`
Expected: PASS (these four modules have no cross-module dependencies on others we haven't ported yet — verify and add stubs if compile fails on missing imports). If failures reference modules we haven't ported (e.g., `./slack-api.js`), comment out the offending imports temporarily and add a `// TODO: re-enable in Task N` marker.

- [ ] **Step 6: Stage**

```bash
git add packages/plugins/paperclip-plugin-slack/src/constants.ts \
        packages/plugins/paperclip-plugin-slack/src/types.ts \
        packages/plugins/paperclip-plugin-slack/src/formatters.ts \
        packages/plugins/paperclip-plugin-slack/src/adapter.ts
git status
```

Suggested commit message: `feat(plugin-slack): port constants, types, formatters, adapter`.

---

## Task 3: Port unchanged feature modules (acp-bridge, custom-commands, media-pipeline, proactive-suggestions)

**Files:**
- Create: `packages/plugins/paperclip-plugin-slack/src/acp-bridge.ts`
- Create: `packages/plugins/paperclip-plugin-slack/src/custom-commands.ts`
- Create: `packages/plugins/paperclip-plugin-slack/src/media-pipeline.ts`
- Create: `packages/plugins/paperclip-plugin-slack/src/proactive-suggestions.ts`

- [ ] **Step 1: Read source from upstream `dist/`**

Read each `.js` file with the Read tool from `~/.paperclip/plugins/node_modules/paperclip-plugin-slack/dist/`.

- [ ] **Step 2: Port to TypeScript verbatim**

For each file:
- Preserve `.js` import extensions (ESM).
- Where function parameters are typed via JSDoc, replace with TS type annotations using types from `./types.js`.
- Where parameters are untyped, leave as-is — `tsc` `--strict` is on; if it complains, add explicit `any` only as a last resort and mark `// TODO type`. Avoid creative refactors.

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter paperclip-plugin-slack typecheck`
Expected: PASS (these depend on `slack-api.ts` which we port in Task 4 — if the executor reaches Task 3 before Task 4, the imports of `./slack-api.js` will fail. In that case stub `slack-api.ts` with empty exports for the function names referenced, so typecheck passes; Task 4 fills it in.).

- [ ] **Step 4: Stage**

```bash
git add packages/plugins/paperclip-plugin-slack/src/acp-bridge.ts \
        packages/plugins/paperclip-plugin-slack/src/custom-commands.ts \
        packages/plugins/paperclip-plugin-slack/src/media-pipeline.ts \
        packages/plugins/paperclip-plugin-slack/src/proactive-suggestions.ts
git status
```

Suggested commit message: `feat(plugin-slack): port feature modules`.

---

## Task 4: Port `slack-api.ts` (existing functions only)

**Files:**
- Create: `packages/plugins/paperclip-plugin-slack/src/slack-api.ts` (extends the existing dist version with new functions in Task 6, but for now port only what's there)
- Create: `packages/plugins/paperclip-plugin-slack/src/__tests__/slack-api.test.ts`

- [ ] **Step 1: Write the failing test for the existing `postMessage` function**

`src/__tests__/slack-api.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { postMessage } from "../slack-api.js";

const mkCtx = () => {
  const fetch = vi.fn().mockResolvedValue({
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: true, ts: "1.2", channel: "C1" }),
  });
  return {
    http: { fetch },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
};

describe("postMessage", () => {
  it("POSTs to chat.postMessage with bearer token and json body", async () => {
    const ctx = mkCtx();
    const result = await postMessage(ctx as any, "xoxb-test", "C1", {
      text: "hello",
    });
    expect(result.ok).toBe(true);
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-test",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ channel: "C1", text: "hello", blocks: undefined }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test — expect failure (module not found)**

Run: `pnpm --filter paperclip-plugin-slack test -- src/__tests__/slack-api.test.ts`
Expected: FAIL — `Cannot find module '../slack-api.js'`.

- [ ] **Step 3: Port `slack-api.ts` from upstream `dist/slack-api.js`**

Read `~/.paperclip/plugins/node_modules/paperclip-plugin-slack/dist/slack-api.js`. Port verbatim, adding TS types:

- `ctx` is typed as `Pick<PluginContext, "http" | "logger">` (import `PluginContext` from `@paperclipai/plugin-sdk`).
- `token` is `string`.
- Preserve `fetchWithRetry`, `postMessage`, `updateMessage`, `respondToAction`, `respondEphemeral`, `getFileInfo`, `downloadFile` exactly.

- [ ] **Step 4: Run test — expect pass**

Run: `pnpm --filter paperclip-plugin-slack test -- src/__tests__/slack-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add packages/plugins/paperclip-plugin-slack/src/slack-api.ts \
        packages/plugins/paperclip-plugin-slack/src/__tests__/slack-api.test.ts
git status
```

Suggested commit message: `feat(plugin-slack): port slack-api with regression test`.

---

## Task 5: Port `manifest.ts` and `worker.ts` (without new tools yet)

**Files:**
- Create: `packages/plugins/paperclip-plugin-slack/src/manifest.ts`
- Create: `packages/plugins/paperclip-plugin-slack/src/worker.ts`
- Create: `packages/plugins/paperclip-plugin-slack/src/index.ts`

- [ ] **Step 1: Port `manifest.ts` from `dist/manifest.js`**

Read upstream `dist/manifest.js`, port to TS, adding:
- Import `PaperclipPluginManifestV1` from `@paperclipai/shared`, type the `manifest` constant.
- Add the new optional `slackUserTokenRef` to `instanceConfigSchema.properties` (NOT in `required[]`):

```ts
slackUserTokenRef: {
  type: "string",
  format: "secret-ref",
  title: "Slack User Token (secret reference, optional)",
  description: "Required for slack_search_messages. Bot tokens cannot use search.messages. Leave blank to disable search.",
  default: "",
},
```

- Leave `tools: []` placeholder (or omit it for now). Tools land in Task 7 / 9.

- [ ] **Step 2: Port `worker.ts` from `dist/worker.js`**

Read upstream `dist/worker.js`. Port verbatim with TS types:

- Top-level imports same shape, `.js` extensions preserved.
- The default export `plugin` typed via `definePlugin` from `@paperclipai/plugin-sdk`.
- Inside `onStart`, all eight existing `ctx.tools.register(...)` calls remain — they will be useless until Task 7 declares them in the manifest, but porting them now means later steps only add new code.

- [ ] **Step 3: Create `src/index.ts`**

```ts
export { default as manifest } from "./manifest.js";
export { default as plugin } from "./worker.js";
```

(Mirrors upstream — used by tests/import smoke.)

- [ ] **Step 4: Build and typecheck**

Run: `pnpm --filter paperclip-plugin-slack build`
Expected: PASS, `dist/` populated.

Run: `pnpm --filter paperclip-plugin-slack typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add packages/plugins/paperclip-plugin-slack/src/manifest.ts \
        packages/plugins/paperclip-plugin-slack/src/worker.ts \
        packages/plugins/paperclip-plugin-slack/src/index.ts
git status
```

Suggested commit message: `feat(plugin-slack): port manifest and worker`.

---

## Task 6: Drop npm bundle and verify the in-tree fork loads

**Files:**
- Modify: `server/src/index.ts:67`

- [ ] **Step 1: Read the BUNDLED_PLUGINS array**

`server/src/index.ts:62-68`:

```ts
const BUNDLED_PLUGINS = [
  "@lucitra/paperclip-plugin-linear",
  "@lucitra/paperclip-plugin-chat",
  "@lucitra/paperclip-plugin-updater",
  "@lucitra/paperclip-plugin-secrets",
  "paperclip-plugin-slack",
];
```

- [ ] **Step 2: Remove the `paperclip-plugin-slack` entry**

Edit `server/src/index.ts`:

```ts
const BUNDLED_PLUGINS = [
  "@lucitra/paperclip-plugin-linear",
  "@lucitra/paperclip-plugin-chat",
  "@lucitra/paperclip-plugin-updater",
  "@lucitra/paperclip-plugin-secrets",
];
```

The in-tree fork is loaded by the local-plugin loader (workspace package) instead of via this auto-install mechanism.

- [ ] **Step 3: Build the workspace plugin**

Run: `pnpm --filter paperclip-plugin-slack build`
Expected: PASS.

- [ ] **Step 4: Run server typecheck**

Run: `pnpm --filter @paperclipai/server typecheck` (or whatever the server's typecheck script is named — check `server/package.json`).
Expected: PASS.

- [ ] **Step 5: Manually verify loader resolution**

Start the dev server (`pnpm dev` from the repo root, or whatever the project's dev command is — see `CONTRIBUTING.md` if unclear). After startup, hit:

```bash
curl -s http://127.0.0.1:3100/api/plugins | jq '.[] | select(.pluginKey == "paperclip-plugin-slack")'
```

Expected: status `ready`, `manifestJson.tools` may be empty (we add tools in Task 7), `manifestJson.version` is `2.1.0` (matches `package.json` we just authored — confirms the workspace fork is being loaded, not the npm copy).

If the version still shows `2.0.7`, the loader is shadowing the workspace copy with the npm install. Resolution: delete the leftover install and reload — `rm -rf ~/.paperclip/plugins/node_modules/paperclip-plugin-slack && pnpm -w remove paperclip-plugin-slack` and restart the server. Document the result in the commit message of this task.

- [ ] **Step 6: Stage**

```bash
git add server/src/index.ts
git status
```

Suggested commit message: `feat(plugin-slack): drop npm bundle, use in-tree fork`.

---

## Task 7: Manifest declares the eight existing handlers

**Files:**
- Modify: `packages/plugins/paperclip-plugin-slack/src/manifest.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/paperclip-plugin-slack/src/__tests__/manifest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import manifest from "../manifest.js";

describe("manifest.tools", () => {
  const expected = [
    "escalate_to_human",
    "handoff_to_agent",
    "discuss_with_agent",
    "process_media",
    "register_command",
    "register_watch",
    "remove_watch",
    "list_watch_templates",
  ];

  it.each(expected)("declares orchestration tool %s", (name) => {
    const tool = manifest.tools?.find((t) => t.name === name);
    expect(tool, `manifest.tools missing ${name}`).toBeDefined();
    expect(tool?.displayName).toBeTruthy();
    expect(tool?.description).toBeTruthy();
    expect(tool?.parametersSchema).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter paperclip-plugin-slack test -- src/__tests__/manifest.test.ts`
Expected: FAIL — all eight assertions fail because `manifest.tools` is empty/undefined.

- [ ] **Step 3: Add the eight tool declarations**

Edit `src/manifest.ts`. Add a `tools:` array. The declarations match the runtime registrations already in `worker.ts` `onStart` — copy the parameter shapes verbatim from the existing `ctx.tools.register("<name>", { displayName, description, parametersSchema }, ...)` calls. For each:

```ts
{
  name: "escalate_to_human",
  displayName: "Escalate to human",
  description: "Pause autonomous work and request human review in Slack…",
  parametersSchema: { /* same schema the worker passes */ },
},
// ...repeat for the other seven
```

The `parametersSchema` JSON Schemas are already in the worker's `register()` call sites at `dist/worker.js:316-577` — copy them.

- [ ] **Step 4: Run test — expect pass**

Run: `pnpm --filter paperclip-plugin-slack test -- src/__tests__/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `pnpm --filter paperclip-plugin-slack build`
Expected: PASS.

- [ ] **Step 6: Stage**

```bash
git add packages/plugins/paperclip-plugin-slack/src/manifest.ts \
        packages/plugins/paperclip-plugin-slack/src/__tests__/manifest.test.ts
git status
```

Suggested commit message: `feat(plugin-slack): declare 8 orchestration tools in manifest`.

---

## Task 8: Extend `slack-api.ts` with new endpoints (TDD)

**Files:**
- Modify: `packages/plugins/paperclip-plugin-slack/src/slack-api.ts`
- Modify: `packages/plugins/paperclip-plugin-slack/src/__tests__/slack-api.test.ts`

This task adds eight new low-level helpers used by the new tool handlers. Each follows the same pattern as the existing `postMessage`: take `ctx`, `token`, params; POST/GET to Slack; return parsed body. Tests mock `ctx.http.fetch` and assert URL, method, body.

- [ ] **Step 1: Add failing tests for `chatUpdate`, `reactionsAdd`, `conversationsList`, `conversationsReplies`, `conversationsJoin`, `conversationsOpen`, `usersList`, `usersInfo`, `usersLookupByEmail`, `searchMessages`, `filesGetUploadURLExternal`, `filesCompleteUploadExternal`**

Append to `src/__tests__/slack-api.test.ts`. One `describe` block per function. Pattern (example for `usersLookupByEmail`):

```ts
describe("usersLookupByEmail", () => {
  it("GETs users.lookupByEmail with email query and bearer token", async () => {
    const ctx = mkCtx();
    (ctx.http.fetch as any).mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, user: { id: "U1", name: "daisy" } }),
    });
    const result = await usersLookupByEmail(ctx as any, "xoxb-test", "daisy@example.com");
    expect(result.ok).toBe(true);
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/users.lookupByEmail?email=daisy%40example.com",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer xoxb-test" }),
      }),
    );
  });
});
```

Write one matching block per function listed at the top of this task (twelve total). Each test asserts:
1. Correct URL (with query-string encoding for GETs).
2. Correct method.
3. Correct headers (Authorization, Content-Type for POSTs).
4. Correct body (POSTs only).

- [ ] **Step 2: Run tests — expect failure (functions undefined)**

Run: `pnpm --filter paperclip-plugin-slack test`
Expected: FAIL — twelve `is not a function` errors.

- [ ] **Step 3: Implement the new functions in `src/slack-api.ts`**

Append to `slack-api.ts`. Reference: <https://api.slack.com/methods>. For each, route through the existing `fetchWithRetry` helper. Brief signatures:

```ts
export async function chatUpdate(ctx, token, channel, ts, message: { text?: string; blocks?: unknown[] }) {
  const res = await fetchWithRetry(ctx, `${SLACK_API_BASE}/chat.update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, ts, text: message.text, blocks: message.blocks }),
  });
  return res.json();
}

export async function reactionsAdd(ctx, token, channel, timestamp, name) { /* POST reactions.add */ }
export async function conversationsList(ctx, token, opts: { types?: string; cursor?: string; limit?: number }) { /* GET conversations.list with query params */ }
export async function conversationsReplies(ctx, token, channel, ts, opts?: { cursor?: string; limit?: number }) { /* GET conversations.replies */ }
export async function conversationsJoin(ctx, token, channel) { /* POST conversations.join */ }
export async function conversationsOpen(ctx, token, users: string) { /* POST conversations.open with `users` */ }
export async function usersList(ctx, token, opts?: { cursor?: string; limit?: number }) { /* GET users.list */ }
export async function usersInfo(ctx, token, user) { /* GET users.info */ }
export async function usersLookupByEmail(ctx, token, email) { /* GET users.lookupByEmail */ }
export async function searchMessages(ctx, userToken, query, opts?: { count?: number; sort?: "score" | "timestamp" }) { /* GET search.messages with USER token */ }
export async function filesGetUploadURLExternal(ctx, token, filename, length) { /* POST files.getUploadURLExternal */ }
export async function filesCompleteUploadExternal(ctx, token, files: Array<{ id: string; title?: string }>, channel?: string) { /* POST files.completeUploadExternal */ }
```

For each:
- Use `URLSearchParams` for GET query params, `JSON.stringify` for POST bodies.
- Always check `body.ok`; log warning via `ctx.logger.warn` on `ok: false` (mirrors the existing `postMessage` pattern).
- Type `ctx` as `Pick<PluginContext, "http" | "logger">` — same as existing helpers.

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm --filter paperclip-plugin-slack test`
Expected: PASS — twelve new tests + existing `postMessage` test.

- [ ] **Step 5: Build**

Run: `pnpm --filter paperclip-plugin-slack build`
Expected: PASS.

- [ ] **Step 6: Stage**

```bash
git add packages/plugins/paperclip-plugin-slack/src/slack-api.ts \
        packages/plugins/paperclip-plugin-slack/src/__tests__/slack-api.test.ts
git status
```

Suggested commit message: `feat(plugin-slack): add Slack API helpers for new tools`.

---

## Task 9: Tool handler module + manifest declarations (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-slack/src/tools.ts`
- Create: `packages/plugins/paperclip-plugin-slack/src/__tests__/tools.test.ts`
- Modify: `packages/plugins/paperclip-plugin-slack/src/manifest.ts` (add eleven new tool declarations)

This is the largest task. Eleven new tool handlers. To keep it manageable, the structure is one shared test scaffold + one block per tool (3-step TDD inside each block: write test, watch fail, implement, watch pass).

- [ ] **Step 1: Write the test scaffold**

Create `src/__tests__/tools.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTools } from "../tools.js";

const SLACK_TOKEN = "xoxb-test";
const USER_TOKEN = "xoxp-test";

const mkCtx = (config: Record<string, unknown> = {}) => {
  const handlers = new Map<string, any>();
  const fetch = vi.fn();
  const ctx: any = {
    http: { fetch },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    secrets: {
      read: vi.fn(async (ref: string) => {
        if (ref === "bot-token-ref") return { value: SLACK_TOKEN };
        if (ref === "user-token-ref") return { value: USER_TOKEN };
        throw new Error(`unknown secret ref: ${ref}`);
      }),
    },
    metrics: { write: vi.fn() },
    tools: {
      register: (name: string, decl: any, fn: any) => {
        handlers.set(name, { decl, fn });
      },
    },
  };
  registerTools(ctx, {
    slackTokenRef: "bot-token-ref",
    slackUserTokenRef: config.slackUserTokenRef as string | undefined,
    ...config,
  });
  return { ctx, handlers, fetch };
};

const mockSlackResponse = (fetch: any, body: any, status = 200) => {
  fetch.mockResolvedValueOnce({
    status,
    headers: { get: () => null },
    json: async () => body,
  });
};
```

- [ ] **Step 2: For each new tool, write a failing test, then implement, then watch it pass**

Repeat the cycle below for **each** of these 11 tools. Each cycle is its own micro-TDD loop.

**Tools (in order):**

1. `slack_post_message` → calls `chat.postMessage`; required: `channel`, `text|blocks`; optional: `thread_ts`.
2. `slack_update_message` → `chat.update`; required: `channel`, `ts`, `text|blocks`.
3. `slack_react` → `reactions.add`; required: `channel`, `timestamp`, `name`.
4. `slack_send_dm` → if `user` looks like email, `users.lookupByEmail` → `conversations.open` → `chat.postMessage`; else `conversations.open` directly.
5. `slack_list_channels` → `conversations.list`; optional: `types`, `name_filter`, `cursor`, `limit`. If `name_filter` provided, filter the response client-side by case-insensitive substring on `name`.
6. `slack_join_channel` → `conversations.join`; required: `channel`.
7. `slack_list_users` → `users.list`; optional: `cursor`, `limit`. Filter out `is_bot` and `deleted` members from response.
8. `slack_get_user_info` → if `user` is email, `users.lookupByEmail`; else `users.info`.
9. `slack_get_thread_replies` → `conversations.replies`; required: `channel`, `thread_ts`.
10. `slack_search_messages` → `search.messages` with the **user** token. If `slackUserTokenRef` is unset, return `{ error: "slack_search_messages requires slackUserTokenRef config (user token). Set it in plugin settings." }` without calling Slack.
11. `slack_upload_file` → `files.getUploadURLExternal` → upload bytes (PUT) to returned URL → `files.completeUploadExternal`. Inputs: `channel`, `filename`, and either `content_base64` or `source_url`. If `source_url`, fetch via `ctx.http.fetch` first.

**Test pattern per tool** (example: `slack_post_message`):

```ts
describe("slack_post_message", () => {
  it("registers and posts a message via chat.postMessage", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: true, ts: "1.2", channel: "C1" });
    const tool = handlers.get("slack_post_message");
    expect(tool).toBeDefined();
    const result = await tool.fn({ channel: "C1", text: "hi" }, {} as any);
    expect(result).toEqual({ output: { ts: "1.2", channel: "C1" } });
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: `Bearer ${SLACK_TOKEN}` }),
      }),
    );
  });

  it("returns { error } on Slack ok:false", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "channel_not_found" });
    const tool = handlers.get("slack_post_message");
    const result = await tool.fn({ channel: "C0", text: "hi" }, {} as any);
    expect(result).toEqual({ error: "channel_not_found" });
  });
});
```

After writing each block:

Run: `pnpm --filter paperclip-plugin-slack test -- src/__tests__/tools.test.ts`
Expected: FAIL on the just-added block.

Then implement the handler in `src/tools.ts` (see Step 3 below) and re-run; expect PASS.

- [ ] **Step 3: Build `src/tools.ts`**

```ts
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import * as slack from "./slack-api.js";

export interface RegisterToolsOptions {
  slackTokenRef: string;
  slackUserTokenRef?: string;
}

export function registerTools(ctx: PluginContext, opts: RegisterToolsOptions): void {
  const readBotToken = async () => (await ctx.secrets.read(opts.slackTokenRef)).value;
  const readUserToken = async () =>
    opts.slackUserTokenRef
      ? (await ctx.secrets.read(opts.slackUserTokenRef)).value
      : null;

  const wrap = (
    name: string,
    decl: { displayName: string; description: string; parametersSchema: object },
    fn: (params: any) => Promise<ToolResult>,
  ) => {
    ctx.tools.register(name, decl, async (params) => {
      try {
        const result = await fn(params);
        await ctx.metrics.write(`slack.tool.${name}.success`, 1);
        return result;
      } catch (err) {
        await ctx.metrics.write(`slack.tool.${name}.error`, 1);
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
      }
    });
  };

  wrap(
    "slack_post_message",
    {
      displayName: "Post Slack message",
      description: "Post a message to a Slack channel. Use channel ID (C…), not name.",
      parametersSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel ID, e.g. C01ABC2DEF3" },
          text: { type: "string", description: "Plain-text message body" },
          blocks: { type: "array", description: "Optional Slack Block Kit blocks" },
          thread_ts: { type: "string", description: "Optional thread timestamp to reply to" },
        },
        required: ["channel"],
      },
    },
    async (params) => {
      const token = await readBotToken();
      const result = await slack.postMessage(ctx, token, params.channel, {
        text: params.text,
        blocks: params.blocks,
      }, params.thread_ts ? { threadTs: params.thread_ts } : undefined);
      if (!result.ok) return { error: result.error ?? "slack_post_message failed" };
      return { output: { ts: result.ts, channel: result.channel } };
    },
  );

  // ...repeat the wrap(...) call for each remaining tool. Pattern for each:
  //   1. Read token (bot or user as needed).
  //   2. Validate params (only required fields — JSON schema validation
  //      is the host's job, not ours).
  //   3. Call slack.<helper>.
  //   4. Map ok:true → { output: <slimmed fields> }; ok:false → { error }.
}
```

For each remaining tool, follow the same wrap pattern. Refer to the per-tool table in the spec for inputs and the slack-api.ts helpers in Task 8 for outputs.

**Slimming rule** for `output`: don't return raw Slack payloads. Pick the relevant fields (e.g., `users.list` → `members.map(m => ({ id, name, real_name, email, is_bot, deleted }))`). This keeps tool outputs token-efficient and stable.

- [ ] **Step 4: After all eleven blocks pass, declare them in the manifest**

Edit `src/manifest.ts`. For each new tool, add an entry to `tools[]` with the same `name`, `displayName`, `description`, `parametersSchema` you used in `wrap()`. Keep declarations in sync with handler bindings — DRY violation here is intentional (manifest must mirror runtime).

Add a manifest test asserting all 19 tools are declared:

```ts
// in src/__tests__/manifest.test.ts
it("declares all 11 Slack-API tools", () => {
  const expected = [
    "slack_post_message", "slack_update_message", "slack_react",
    "slack_send_dm", "slack_list_channels", "slack_join_channel",
    "slack_list_users", "slack_get_user_info", "slack_get_thread_replies",
    "slack_search_messages", "slack_upload_file",
  ];
  for (const name of expected) {
    expect(manifest.tools?.find((t) => t.name === name), `missing ${name}`).toBeDefined();
  }
});
```

- [ ] **Step 5: Wire `registerTools` into `worker.ts`'s `onStart`**

Edit `src/worker.ts`. Inside `onStart(ctx)`, after the existing eight `ctx.tools.register(...)` calls, add:

```ts
const config = ctx.config as SlackPluginConfig;
registerTools(ctx, {
  slackTokenRef: config.slackTokenRef,
  slackUserTokenRef: config.slackUserTokenRef,
});
```

Import `registerTools` from `./tools.js` and `SlackPluginConfig` from `./types.js`.

- [ ] **Step 6: Final tests + build**

Run: `pnpm --filter paperclip-plugin-slack test`
Expected: PASS — all of: 1 postMessage test + 12 slack-api helper tests + 8 orchestration manifest tests + 11 Slack-API manifest tests + 22 tool handler tests (2 per new tool: success + error). ~54 tests.

Run: `pnpm --filter paperclip-plugin-slack build`
Expected: PASS.

- [ ] **Step 7: Stage**

```bash
git add packages/plugins/paperclip-plugin-slack/src/tools.ts \
        packages/plugins/paperclip-plugin-slack/src/__tests__/tools.test.ts \
        packages/plugins/paperclip-plugin-slack/src/__tests__/manifest.test.ts \
        packages/plugins/paperclip-plugin-slack/src/manifest.ts \
        packages/plugins/paperclip-plugin-slack/src/worker.ts
git status
```

Suggested commit message: `feat(plugin-slack): add 11 Slack-API agent tools`.

---

## Task 10: End-to-end verification

This task does not change source. It verifies the fork works in a running instance.

- [ ] **Step 1: Restart the dev server**

Stop and restart whatever the project's dev runner is. Watch logs for:

```
plugin-loader: agent tools registered { pluginId: "paperclip-plugin-slack", toolCount: 19 }
```

If `toolCount: 0`, something didn't wire — re-check Task 9 step 4 (manifest declarations) and Task 6 step 5 (loader resolution).

- [ ] **Step 2: Confirm tools appear via API**

```bash
curl -s http://127.0.0.1:3100/api/plugin-tools | jq '.[] | select(.pluginId == "paperclip-plugin-slack") | .namespacedName'
```

Expected output (19 lines):

```
"paperclip-plugin-slack:slack_post_message"
"paperclip-plugin-slack:slack_update_message"
... etc ...
```

(If the endpoint name differs, find the right route via `grep -n "plugin-tools\|listTools" server/src/routes/*.ts`.)

- [ ] **Step 3: Regression: slash commands still work**

In Slack, run `/clip status` and `/clip agents`. Expected: ephemeral message renders correctly (or at least: the same behavior as before this PR; the slash-command JSON rendering bug is out of scope for this plan).

- [ ] **Step 4: Smoke: agent posts a message**

Assign an agent a task: "Post the message `hello from the fork` to the default Slack channel." Watch the agent's tool calls — confirm `paperclip-plugin-slack:slack_post_message` is invoked. Verify the message appears in Slack.

- [ ] **Step 5: Smoke: agent lists channels**

Assign: "List Slack channels." Confirm `paperclip-plugin-slack:slack_list_channels` is called and returns IDs/names.

- [ ] **Step 6: Stage and finalize**

No new changes from this task; only verification. If steps 1-5 all pass, the plan is complete. If any step fails, file a follow-up issue with the failure context — do NOT inline-fix here unless the failure is a missed line in an earlier task.

---

## Self-review notes

- **Spec coverage**: All 11 new tools (Task 9) ✓. All 8 existing handlers declared in manifest (Task 7) ✓. Plugin key preserved (Task 1, package.json) ✓. `slackUserTokenRef` config added (Task 2 + Task 5) ✓. `BUNDLED_PLUGINS` updated (Task 6) ✓. Tests for each tool (Task 8 + Task 9) ✓.
- **Type consistency**: `RegisterToolsOptions` defined in Task 9 step 3, used in Task 9 step 5. `SlackPluginConfig` defined in Task 2 (with new `slackUserTokenRef` field). Tool names consistent across declarations and handlers (table in Task 9 step 2 is the canonical list).
- **Placeholders**: None left as TBD/TODO. The "comment out missing imports" guidance in Task 2 Step 5 / Task 3 Step 3 is a build-order workaround, not a placeholder.
- **Out-of-scope items** (slash-command rendering, app_mention routing) are explicitly listed in the spec; no tasks for them.
