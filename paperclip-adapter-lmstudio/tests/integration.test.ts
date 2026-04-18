import { describe, it, expect } from "vitest";
import { createServerAdapter } from "../src/server/index.js";
import { PAPERCLIP_TOOLS } from "../src/server/tools.js";

describe("adapter integration", () => {
  it("createServerAdapter returns adapter with required methods", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("lmstudio_local");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    expect(typeof adapter.listModels).toBe("function");
    expect(typeof adapter.getConfigSchema).toBe("function");
  });

  it("getConfigSchema includes maxIterations field", async () => {
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    const keys = schema.fields.map((f: { key: string }) => f.key);
    expect(keys).toContain("url");
    expect(keys).toContain("defaultModel");
    expect(keys).toContain("timeoutMs");
    expect(keys).toContain("streamingEnabled");
    expect(keys).toContain("maxIterations");
  });

  it("PAPERCLIP_TOOLS has 18 tools available to execute()", () => {
    expect(PAPERCLIP_TOOLS.length).toBe(18);
  });
});
