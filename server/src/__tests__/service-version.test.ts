import { describe, expect, it } from "vitest";

import { resolveServiceVersion } from "../instrumentation.js";

describe("resolveServiceVersion", () => {
  it("prefers the built commit over runtime and environment fallbacks", () => {
    expect(resolveServiceVersion("built", "runtime", "env")).toBe("built");
    expect(resolveServiceVersion(null, "runtime", "env")).toBe("runtime");
    expect(resolveServiceVersion(null, null, "env")).toBe("env");
    expect(resolveServiceVersion(null, null, undefined)).toBe("unknown");
  });
});
