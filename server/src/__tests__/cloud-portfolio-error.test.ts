import { describe, expect, it } from "vitest";
import { CloudPortfolioError } from "../services/cloud-portfolio-error.js";

const input = { phase: "fetch" as const, elapsedMs: 270.2, upstreamStatus: null };

describe("CloudPortfolioError", () => {
  it("retains only an allowlisted nested network code, not the original exception", () => {
    const cause = Object.assign(new Error("private upstream payload"), { code: "ECONNRESET", url: "https://private.example.test" });
    const error = new CloudPortfolioError("upstream", input, new TypeError("fetch failed", { cause }));
    expect(error.diagnostics).toEqual({ phase: "fetch", elapsedMs: 270, upstreamStatus: null, networkCode: "ECONNRESET" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("private");
    expect(Object.isFrozen(error.diagnostics)).toBe(true);
  });

  it.each([
    new Error("ECONNRESET in a private message is not evidence"),
    { code: "private-provider-code" },
    { get code() { throw new Error("private getter"); }, get cause() { throw new Error("private getter"); } },
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private proxy"); } }),
  ])("fails closed for unknown errors without invoking getters", (cause) => {
    expect(new CloudPortfolioError("upstream", input, cause).diagnostics.networkCode).toBe("unknown");
  });

  it("bounds cause traversal and handles cycles", () => {
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(new CloudPortfolioError("upstream", input, cycle).diagnostics.networkCode).toBe("unknown");
    const deep = { cause: { cause: { cause: { cause: { code: "ECONNRESET" } } } } };
    expect(new CloudPortfolioError("upstream", input, deep).diagnostics.networkCode).toBe("unknown");
  });

  it("normalizes unsafe diagnostics and keeps non-network phases distinct", () => {
    const error = new CloudPortfolioError("upstream", {
      phase: "private-phase" as never, elapsedMs: Infinity, upstreamStatus: 900,
    }, { code: "ECONNRESET" });
    expect(error.diagnostics).toEqual({ phase: "unknown", elapsedMs: null, upstreamStatus: null, networkCode: "unknown" });
    for (const phase of ["http_response", "response_write"] as const) {
      expect(new CloudPortfolioError("upstream", { ...input, phase, upstreamStatus: 503, deadlineExceeded: true }, { code: "ECONNRESET" }).diagnostics)
        .toMatchObject({ phase, upstreamStatus: 503, networkCode: "unknown" });
    }
    expect(new CloudPortfolioError("upstream", { ...input, elapsedMs: 60_001 }).diagnostics.elapsedMs).toBeNull();
    expect(new CloudPortfolioError("upstream", { ...input, elapsedMs: -1 }).diagnostics.elapsedMs).toBeNull();
  });
});
