import { describe, expect, it } from "vitest";
import {
  deriveToolSchemaTelemetry,
  unsupportedToolSchemaTelemetry,
} from "./tool-schema-telemetry.js";

describe("tool-schema-telemetry", () => {
  it("counts tools and groups by source", () => {
    const t = deriveToolSchemaTelemetry({
      tools: [
        { name: "git_commit", source: "managed" },
        { name: "fs_read", source: "core" },
        { name: "wrap_x", source: "wrapper" },
        { name: "wrap_y", source: "wrapper" },
      ],
    });
    expect(t.measurementKind).toBe("derived");
    expect(t.registeredToolCount).toBe(4);
    expect(t.toolsBySource).toEqual({
      managed: 1,
      core: 1,
      wrapper: 2,
    });
    expect(t.duplicateToolNames).toEqual([]);
  });

  it("detects duplicate tool names", () => {
    const t = deriveToolSchemaTelemetry({
      tools: [
        { name: "dupe", source: "managed" },
        { name: "dupe", source: "core" },
        { name: "unique", source: "managed" },
      ],
    });
    expect(t.duplicateToolNames).toEqual(["dupe"]);
  });

  it("sums serialized schema chars plus config chars", () => {
    const t = deriveToolSchemaTelemetry({
      tools: [
        { name: "a", source: "managed", serializedSchema: '{"x":1}' },
        { name: "b", source: "core", serializedSchema: '{"y":2,"z":3}' },
      ],
      serializedConfigChars: 10,
    });
    // 7 + 13 + 10 = 30
    expect(t.serializedToolSchemaChars).toBe(30);
  });

  it("treats missing schema as 0 chars", () => {
    const t = deriveToolSchemaTelemetry({
      tools: [{ name: "a", source: "managed" }],
    });
    expect(t.serializedToolSchemaChars).toBe(0);
    expect(t.registeredToolCount).toBe(1);
  });

  it("reports explicit unsupported with reason instead of NOT_EXPOSED", () => {
    const t = unsupportedToolSchemaTelemetry("provider-native schemas unenumerable");
    expect(t.measurementKind).toBe("unsupported");
    expect(t.unsupportedReason).toBe("provider-native schemas unenumerable");
    expect(t.registeredToolCount).toBe(0);
  });
});
