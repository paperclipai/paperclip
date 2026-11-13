import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { SUBSCRIBED_EVENTS } from "../src/worker.js";
import { BASE_CONFIG } from "./fixtures.js";

vi.mock("@paperclipai/plugin-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/plugin-sdk")>()),
  runWorker: () => {},
}));

describe("worker wiring", () => {
  it("registers each event name exactly once", async () => {
    const harness = createTestHarness({ manifest, config: BASE_CONFIG });
    const on = vi.spyOn(harness.ctx.events, "on");
    await plugin.definition.setup(harness.ctx);
    const names = on.mock.calls.map((call) => call[0]);
    expect(names).toEqual([...SUBSCRIBED_EVENTS]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("validates config through onValidateConfig", async () => {
    await expect(plugin.definition.onValidateConfig?.(BASE_CONFIG)).resolves.toEqual({ ok: true });
    const bad = await plugin.definition.onValidateConfig?.({ ...BASE_CONFIG, topic: "" });
    expect(bad?.ok).toBe(false);
  });

  it("declares only the capabilities it uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "companies.read",
      "events.subscribe",
      "http.outbound",
      "issue.interactions.read",
      "issues.read",
      "plugin.state.read",
      "plugin.state.write",
      "secrets.read-ref",
    ]);
    expect(manifest.entrypoints.ui).toBeUndefined();
  });
});
