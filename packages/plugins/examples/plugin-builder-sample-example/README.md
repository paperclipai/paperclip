# plugin-builder-sample-example

Reference plugin demonstrating the **Builder surface** for plugin tools added in Phase 3 of the [Company AI Builder plan](../../../../doc/plans/2026-05-04-company-ai-builder.md).

## What it shows

* Declares one tool (`current_time`) with `surfaces: ["agent", "builder"]` in `manifest.ts`.
* Implements the tool in `worker.ts` using the standard `ctx.tools.register(...)` API — no Builder-specific code required.

When the host loads the plugin, the bridge in `server/src/services/builder/plugin-bridge.ts` notices the `"builder"` surface and adds the tool to the Builder catalog automatically. The same handler runs whether the tool is invoked by an agent or by the Builder copilot.

## Try it

1. Build the example: `pnpm --filter @paperclipai/plugin-builder-sample-example build`.
2. Add the plugin to a company through the Plugins page.
3. Open **AI Builder** → tool catalog drawer; the `current_time` tool will appear with the `plugin.paperclip.builder-sample-example` capability badge.
4. Ask the model "what time is it?" and confirm the tool result is surfaced in the chat transcript.
