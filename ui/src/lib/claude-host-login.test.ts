// @vitest-environment node

import { describe, expect, it } from "vitest";
import { shouldOfferClaudeHostLogin } from "./claude-host-login";

describe("shouldOfferClaudeHostLogin", () => {
  it("offers the host-local login when execution is unrestricted", () => {
    expect(shouldOfferClaudeHostLogin("any")).toBe(true);
  });

  it("offers the host-local login when the execution mode is not loaded/absent", () => {
    expect(shouldOfferClaudeHostLogin(undefined)).toBe(true);
  });

  it("does NOT offer the host-local login when execution is forced onto the Kubernetes sandbox", () => {
    expect(shouldOfferClaudeHostLogin("kubernetes")).toBe(false);
  });
});
