import { describe, it, expectTypeOf } from "vitest";
import type { ServerAdapterModule } from "./types.js";

describe("ServerAdapterModule.networkRequirements", () => {
  it("accepts an allowFqdns array on a module shape", () => {
    const m: Pick<ServerAdapterModule, "type" | "networkRequirements"> = {
      type: "test",
      networkRequirements: { allowFqdns: ["api.anthropic.com"] },
    };
    // networkRequirements is assignable
    expectTypeOf(m.networkRequirements).toMatchTypeOf<{ allowFqdns?: string[] } | undefined>();
  });
});
