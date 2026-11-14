import { describe, expect, it } from "vitest";
import { runScopedMcpTokenExpiresAt } from "./mcp-token-expiry.js";

const MINTED_AT = Date.parse("2026-10-20T00:00:00.000Z");

describe("run-scoped MCP token expiry", () => {
  it("defaults to four hours when the run has no configured timeout", () => {
    expect(runScopedMcpTokenExpiresAt({}, MINTED_AT).getTime() - MINTED_AT)
      .toBe(4 * 60 * 60 * 1_000);
  });

  it("covers configured timeout, grace, and fifteen minutes", () => {
    expect(runScopedMcpTokenExpiresAt({ timeoutSec: 6 * 60 * 60, graceSec: 30 }, MINTED_AT).getTime() - MINTED_AT)
      .toBe((6 * 60 * 60 + 30 + 15 * 60) * 1_000);
  });

  it("requires renewal rather than minting a credential longer than 24 hours", () => {
    expect(() => runScopedMcpTokenExpiresAt({ timeoutSec: 24 * 60 * 60 }, MINTED_AT))
      .toThrow("need renewal");
  });
});
