import { describe, expect, it } from "vitest";
import { buildEmbeddedPostgresFlags } from "./embedded-postgres-flags.js";

describe("buildEmbeddedPostgresFlags", () => {
  it("returns postgres flags locking listen_addresses to 127.0.0.1", () => {
    const flags = buildEmbeddedPostgresFlags();
    expect(flags).toContain("-c");
    expect(flags).toContain("listen_addresses=127.0.0.1");
    expect(flags).toEqual(["-c", "listen_addresses=127.0.0.1"]);
  });

  it("returns a new array each call (no shared state)", () => {
    const a = buildEmbeddedPostgresFlags();
    const b = buildEmbeddedPostgresFlags();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
