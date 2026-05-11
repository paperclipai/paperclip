import { describe, expect, it } from "vitest";
import { instanceGeneralSettingsSchema, patchInstanceGeneralSettingsSchema } from "./instance.js";
import { PLUGIN_CAPABILITIES } from "../constants.js";

describe("containers.manage capability", () => {
  it("is present in PLUGIN_CAPABILITIES", () => {
    expect(PLUGIN_CAPABILITIES).toContain("containers.manage");
  });
});

describe("instanceGeneralSettingsSchema containerEngine", () => {
  it("defaults containerEngine to disabled", () => {
    const result = instanceGeneralSettingsSchema.parse({});
    expect(result.containerEngine).toEqual({
      driver: "disabled",
      networkMode: "none",
      allowRootUser: false,
      memoryMbMax: 4096,
      maxLifetimeSecMax: 86400,
      concurrencyPerPlugin: 10,
    });
  });

  it("accepts docker driver", () => {
    const result = instanceGeneralSettingsSchema.parse({
      containerEngine: { driver: "docker" },
    });
    expect(result.containerEngine.driver).toBe("docker");
    expect(result.containerEngine.networkMode).toBe("none");
  });

  it("accepts podman driver", () => {
    const result = instanceGeneralSettingsSchema.parse({
      containerEngine: { driver: "podman" },
    });
    expect(result.containerEngine.driver).toBe("podman");
  });

  it("rejects invalid driver values", () => {
    const result = instanceGeneralSettingsSchema.safeParse({
      containerEngine: { driver: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects networkMode other than none or bridge", () => {
    const result = instanceGeneralSettingsSchema.safeParse({
      containerEngine: { driver: "docker", networkMode: "host" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects memoryMbMax below 128", () => {
    const result = instanceGeneralSettingsSchema.safeParse({
      containerEngine: { driver: "docker", memoryMbMax: 64 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects concurrencyPerPlugin above 100", () => {
    const result = instanceGeneralSettingsSchema.safeParse({
      containerEngine: { driver: "docker", concurrencyPerPlugin: 101 },
    });
    expect(result.success).toBe(false);
  });
});

describe("patchInstanceGeneralSettingsSchema containerEngine", () => {
  it("accepts partial containerEngine patch", () => {
    const result = patchInstanceGeneralSettingsSchema.parse({
      containerEngine: { driver: "docker" },
    });
    expect(result.containerEngine?.driver).toBe("docker");
  });

  it("accepts patch without containerEngine field", () => {
    const result = patchInstanceGeneralSettingsSchema.parse({
      keyboardShortcuts: true,
    });
    expect(result.containerEngine).toBeUndefined();
  });
});

describe("containerEngine partial-update merge correctness", () => {
  it("deep-merging patch.containerEngine with current preserves existing non-patched fields", () => {
    const current = instanceGeneralSettingsSchema.parse({
      containerEngine: { driver: "docker", networkMode: "bridge", concurrencyPerPlugin: 5 },
    });
    const patch = patchInstanceGeneralSettingsSchema.parse({
      containerEngine: { concurrencyPerPlugin: 20 },
    });
    // Simulate the correct deep merge: patch.containerEngine overlaid on current.containerEngine
    const merged = instanceGeneralSettingsSchema.parse({
      ...current,
      containerEngine: patch.containerEngine
        ? { ...current.containerEngine, ...patch.containerEngine }
        : current.containerEngine,
    });
    expect(merged.containerEngine.driver).toBe("docker");
    expect(merged.containerEngine.networkMode).toBe("bridge");
    expect(merged.containerEngine.concurrencyPerPlugin).toBe(20);
  });

  it("shallow spread of patch.containerEngine resets driver to disabled — demonstrates the bug", () => {
    const current = instanceGeneralSettingsSchema.parse({
      containerEngine: { driver: "docker", networkMode: "bridge" },
    });
    const patch = patchInstanceGeneralSettingsSchema.parse({
      containerEngine: { concurrencyPerPlugin: 20 },
    });
    // Buggy behavior: shallow spread replaces entire containerEngine object
    const buggy = instanceGeneralSettingsSchema.parse({
      ...current,
      ...patch,
    });
    // driver should be "docker" but shallow spread resets it to "disabled"
    expect(buggy.containerEngine.driver).toBe("disabled");
  });
});
