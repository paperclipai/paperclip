import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("worker kurulum", () => {
  it("kurulumda hem durum hem ayar veri işleyicisini kaydeder", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const config = await harness.getData<Record<string, unknown>>("plugin-config", {});
    expect(config).toMatchObject({
      issueId: null,
      documentKey: "sosyal-medya-durum",
      scanLimit: 30,
    });
  });

  it("no-company durumunda veri işleyicisi hatasız çalışır", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const sonuc = await harness.getData<{ status?: string }>("sosyal-medya-durum", {});
    expect(sonuc.status).toBe("no-company");
  });

  it("manifest sürüm ve girdi noktalarını beyan eder", () => {
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.entrypoints?.worker).toBe("./dist/worker.js");
    expect(manifest.entrypoints?.ui).toBe("./dist/ui");
  });
});
