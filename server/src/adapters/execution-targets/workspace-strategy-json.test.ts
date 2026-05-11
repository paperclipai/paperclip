import { describe, it, expect } from "vitest";
import { buildAdapterManagedWorkspaceRequestJson } from "./workspace-strategy-json.js";

describe("buildAdapterManagedWorkspaceRequestJson", () => {
  it("emits a shape that satisfies the workspace-init parseRequest contract", () => {
    // Mirror of the validation in tools/workspace-init/src/parse-request.ts.
    // If you change the parseRequest contract, update both ends and the
    // dedicated parser test in tools/workspace-init/.
    const json = buildAdapterManagedWorkspaceRequestJson();
    const parsed = JSON.parse(json) as {
      version: unknown;
      source?: { strategy?: unknown };
    };
    expect(parsed.version).toBe(1);
    expect(typeof parsed.source?.strategy).toBe("string");
  });

  it("uses 'adapter_managed' so executeWorkspaceStrategy treats it as a no-op", () => {
    const json = buildAdapterManagedWorkspaceRequestJson();
    expect(JSON.parse(json)).toEqual({
      version: 1,
      source: { strategy: "adapter_managed" },
    });
  });
});
