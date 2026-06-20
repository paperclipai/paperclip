import { describe, it, expect } from "vitest";
import { runWithBearer, currentBearer } from "./auth-context.js";

describe("auth-context", () => {
  it("returns null outside any run scope", () => {
    expect(currentBearer()).toBeNull();
  });

  it("exposes the bearer inside a run scope", () => {
    const seen = runWithBearer("Bearer pcp_abc", () => currentBearer());
    expect(seen).toBe("Bearer pcp_abc");
  });

  it("isolates concurrent scopes (no leakage across awaits)", async () => {
    const results = await Promise.all([
      runWithBearer("Bearer A", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentBearer();
      }),
      runWithBearer("Bearer B", async () => currentBearer()),
    ]);
    expect(results).toEqual(["Bearer A", "Bearer B"]);
  });
});
