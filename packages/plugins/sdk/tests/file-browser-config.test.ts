import { describe, expect, it, vi } from "vitest";

import { createTestHarness } from "../src/testing.js";
import { definePlugin } from "../src/define-plugin.js";
import manifest from "../../examples/plugin-file-browser-example/src/manifest.js";

vi.mock("@paperclipai/plugin-sdk", () => ({ definePlugin, runWorker: vi.fn() }));

const { default: plugin } = await import("../../examples/plugin-file-browser-example/src/worker.js");

describe("file browser plugin config", () => {
  it("reads saved settings from invocation scope without company params", async () => {
    const harness = createTestHarness({ manifest });
    const getConfig = vi.spyOn(harness.ctx.config, "get").mockResolvedValue({
      showFilesInSidebar: true,
      commentAnnotationMode: "inline",
    });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("plugin-config", {})).resolves.toEqual({
      showFilesInSidebar: true,
      commentAnnotationMode: "inline",
    });
    expect(getConfig).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps defaults when the scoped config has no saved settings", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("plugin-config", {})).resolves.toEqual({
      showFilesInSidebar: false,
      commentAnnotationMode: "both",
    });
  });
});
