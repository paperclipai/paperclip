# `@paperclipai/plugin-sdk`

Official TypeScript SDK for Paperclip plugin authors.

- Worker SDK: `@paperclipai/plugin-sdk`
- UI SDK: `@paperclipai/plugin-sdk/ui`
- Testing utilities: `@paperclipai/plugin-sdk/testing`
- Bundler presets: `@paperclipai/plugin-sdk/bundlers`
- Local dev server helpers: `@paperclipai/plugin-sdk/dev-server`

Reference spec: `doc/plugins/PLUGIN_SPEC.md`

## Package surface

- `@paperclipai/plugin-sdk`: worker/runtime types and `definePlugin`
- `@paperclipai/plugin-sdk/ui`: typed React hooks and host UI helpers
- `@paperclipai/plugin-sdk/testing`: in-memory host test harness
- `@paperclipai/plugin-sdk/bundlers`: esbuild/rollup preset generators
- `@paperclipai/plugin-sdk/dev-server`: local static UI server + SSE reload stream

## Install

```bash
pnpm add @paperclipai/plugin-sdk
```

## Worker quick start

```ts
import { definePlugin } from "@paperclipai/plugin-sdk";

export default definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      ctx.logger.info("Issue created", { issueId: event.entityId });
    });

    ctx.data.register("health", async () => ({ status: "ok" }));
    ctx.actions.register("ping", async () => ({ pong: true }));
  },
});
```

## UI quick start

```tsx
import { usePluginData, usePluginAction, MetricCard } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget() {
  const { data } = usePluginData<{ status: string }>("health");
  const ping = usePluginAction("ping");
  return (
    <div>
      <MetricCard label="Health" value={data?.status ?? "unknown"} />
      <button onClick={() => void ping()}>Ping</button>
    </div>
  );
}
```

## Testing utilities

```ts
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.js";
import manifest from "../src/manifest.js";

const harness = createTestHarness({ manifest });
await plugin.definition.setup(harness.ctx);
await harness.emit("issue.created", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
```

## Bundler presets

```ts
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
// presets.esbuild.worker / presets.esbuild.manifest / presets.esbuild.ui
// presets.rollup.worker / presets.rollup.manifest / presets.rollup.ui
```

## Local dev server (hot-reload events)

```bash
paperclip-plugin-dev-server --root . --ui-dir dist/ui --port 4177
```

Or programmatically:

```ts
import { startPluginDevServer } from "@paperclipai/plugin-sdk/dev-server";
const server = await startPluginDevServer({ rootDir: process.cwd() });
```

Dev server endpoints:
- `GET /__paperclip__/health` returns `{ ok, rootDir, uiDir }`
- `GET /__paperclip__/events` streams `reload` SSE events on UI build changes
