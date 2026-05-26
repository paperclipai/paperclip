import { describe, expect, it } from "vitest";
import { printGeminiStreamEvent } from "@paperclipai/adapter-gemini-local/cli";

import { getCLIAdapter } from "../adapters/registry.js";

describe("CLI adapter registry", () => {
  it("registers agy_local with the Antigravity/Gemini stream formatter", () => {
    const adapter = getCLIAdapter("agy_local");

    expect(adapter.type).toBe("agy_local");
    expect(adapter.formatStdoutEvent).toBe(printGeminiStreamEvent);
  });
});
