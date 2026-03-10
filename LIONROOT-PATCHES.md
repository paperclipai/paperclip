# LIONROOT-PATCHES.md

Maintained Lionroot delta for the Paperclip fork under `command-post/paperclip-server`.

## 1. Lionroot-owned surface

These files implement the Lionroot OpenClaw webhook adapter and should be treated as Lionroot-owned. Upstream does not provide this adapter. This fork also carries upstream `openclaw_gateway` separately; both adapter types are intentionally supported.

- `packages/adapters/openclaw/package.json`
- `packages/adapters/openclaw/tsconfig.json`
- `packages/adapters/openclaw/src/index.ts`
- `packages/adapters/openclaw/src/cli/format-event.ts`
- `packages/adapters/openclaw/src/cli/index.ts`
- `packages/adapters/openclaw/src/server/execute.ts`
- `packages/adapters/openclaw/src/server/index.ts`
- `packages/adapters/openclaw/src/server/parse.ts`
- `packages/adapters/openclaw/src/server/test.ts`
- `packages/adapters/openclaw/src/server/execute.test.ts`
- `packages/adapters/openclaw/src/ui/build-config.ts`
- `packages/adapters/openclaw/src/ui/index.ts`
- `packages/adapters/openclaw/src/ui/parse-stdout.ts`

### Current adapter semantics to preserve

- Webhook payloads include a top-level `message` field.
- Webhook payloads include a top-level merged `context` object for hook consumers.
- Hook payload context includes `source: "paperclip"` and the computed wake metadata.
- `payloadTemplate.context` can extend the top-level `context`, but computed wake metadata wins on collisions.
- The original nested `paperclip` payload remains present for consumers that depend on the full Paperclip context envelope.

## 2. Structural wiring added by Lionroot

These upstream-owned files must continue to register the Lionroot webhook adapter while also preserving upstream `openclaw_gateway` support.

- `cli/package.json` — keep both workspace deps: `@paperclipai/adapter-openclaw` and `@paperclipai/adapter-openclaw-gateway`
- `cli/src/adapters/registry.ts` — register both adapter types: `openclaw` and `openclaw_gateway`
- `packages/shared/src/constants.ts` — adapter union must include both `"openclaw"` and upstream `"openclaw_gateway"`
- `server/package.json` — keep both server-side workspace deps
- `server/src/adapters/registry.ts` — register both adapter types in server adapter lookup
- `tsconfig.json` — keep both adapter package references in the monorepo project refs
- `ui/package.json` — keep both UI-side workspace deps
- `ui/src/adapters/openclaw/config-fields.tsx`
- `ui/src/adapters/openclaw/index.ts`
- `ui/src/adapters/registry.ts` — register both UI adapters
- `ui/src/components/AgentProperties.tsx` — keep distinct labels for webhook vs gateway adapters
- `ui/src/components/agent-config-primitives.tsx` — document both adapter modes in operator help text
- `ui/src/pages/Agents.tsx` — keep distinct adapter labels in lists
- `ui/src/pages/OrgChart.tsx` — keep distinct adapter labels in org chart cards
- `vitest.config.ts` — include `packages/adapters/openclaw` in the project list so webhook adapter tests run
- `pnpm-lock.yaml` — regenerate from install if conflicts occur

## 3. Upstream patch files

These are small targeted patches in upstream-owned files and are the most likely merge-conflict points during sync.

### `Dockerfile`
Keep the Lionroot Docker workaround that skips the server image build step and relies on pre-built `server/dist` output.

Replay patch:
```diff
-RUN pnpm --filter @paperclipai/server build
-RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
+# Server dist is pre-built in repo; keep the Lionroot Docker workaround until
+# the server build is confirmed stable in this image.
```

### `server/src/index.ts`
Preserve the Lionroot loopback behavior that treats `0.0.0.0` as loopback in `isLoopbackHost(...)` so private/local deployment mode works when Paperclip binds all interfaces.

Replay patch:
```diff
-return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
+return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "0.0.0.0";
```

## 4. Mainline policy

- Fork mainline is `master` and should remain the deployable Lionroot branch.
- Future upstream syncs should merge `upstream/master` into fork `master` and resolve only the documented files above.
- If `pnpm-lock.yaml` conflicts, regenerate it from a clean install with the repo's pinned package manager (`pnpm@9.15.4`).
