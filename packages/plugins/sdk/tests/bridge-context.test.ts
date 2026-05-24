import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import { definePlugin } from "../src/define-plugin.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

const manifest: PaperclipPluginManifestV1 = {
  apiVersion: 1,
  id: "paperclip.test.bridge-context",
  displayName: "Bridge Context Test",
  version: "0.0.0",
  description: "Tests trusted bridge request context.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

describe("plugin bridge request context", () => {
  it("makes trusted actor context available to data and action handlers", async () => {
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("whoami", async (_params, request) => request.actor);
        ctx.actions.register("whoami", async (_params, request) => request.actor);
      },
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);

    const actor = {
      actorType: "user" as const,
      actorId: "user-1",
      userId: "user-1",
      agentId: null,
      runId: "run-1",
      source: "session",
    };

    await expect(harness.getData("whoami", {}, { actor })).resolves.toEqual(actor);
    await expect(harness.performAction("whoami", {}, { actor })).resolves.toEqual(actor);
  });
});
