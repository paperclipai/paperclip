import { describe, expect, it } from "vitest";

import { resolveServiceVersion } from "../instrumentation.js";

describe("resolveServiceVersion", () => {
  it("prefers the build stamp over every other source", () => {
    expect(resolveServiceVersion("aaaaaaa", "bbbbbbb", "2026.5.0")).toBe("aaaaaaa");
  });

  it("uses the runtime git commit when no build stamp exists", () => {
    expect(resolveServiceVersion(null, "bbbbbbb", "2026.5.0")).toBe("bbbbbbb");
  });

  it("uses OTEL_SERVICE_VERSION when no stamp and no git commit exist", () => {
    expect(resolveServiceVersion(null, null, "2026.5.0")).toBe("2026.5.0");
  });

  it("falls back to 'unknown' when every source is absent", () => {
    expect(resolveServiceVersion(null, null, undefined)).toBe("unknown");
  });

  it("treats an empty env value as absent", () => {
    expect(resolveServiceVersion(null, null, "")).toBe("unknown");
  });
});
