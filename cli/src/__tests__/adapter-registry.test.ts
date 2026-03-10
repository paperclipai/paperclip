import { describe, expect, it } from "vitest";
import { getCLIAdapter } from "../adapters/registry.js";

describe("CLI adapter registry", () => {
  it("registers hermes_local with a stdout formatter", () => {
    const adapter = getCLIAdapter("hermes_local");

    expect(adapter.type).toBe("hermes_local");
    expect(typeof adapter.formatStdoutEvent).toBe("function");
  });

  it("registers hermes_gateway with a stdout formatter", () => {
    const adapter = getCLIAdapter("hermes_gateway");

    expect(adapter.type).toBe("hermes_gateway");
    expect(typeof adapter.formatStdoutEvent).toBe("function");
  });
});
