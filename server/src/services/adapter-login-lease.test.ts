import { describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";
import { buildLoginLeaseAcquireArgs } from "./adapter-login-lease.js";

// A minimal environment stand-in. The helper copies the reference without a
// read, so the test does not need a full environment row.
const ENVIRONMENT = { id: "env-1", name: "Sandbox", driver: "sandbox" } as unknown as Environment;

describe("buildLoginLeaseAcquireArgs", () => {
  it("sets the fixed lease arguments that both login services share", () => {
    const args = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT, adapterType: "codex" },
    });

    // A null issue, a null heartbeat run, and a null execution workspace disable
    // lease reuse, so the login session always runs in a fresh sandbox.
    expect(args.issueId).toBeNull();
    expect(args.heartbeatRunId).toBeNull();
    expect(args.persistedExecutionWorkspace).toBeNull();
    // The helper applies the active custom-image template for both services.
    expect(args.applyCustomImageTemplate).toBe(true);
  });

  it("passes the lease metadata through to the acquire arguments", () => {
    const args = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT, adapterType: "claude" },
    });

    expect(args.companyId).toBe("co-1");
    expect(args.environment).toBe(ENVIRONMENT);
    expect(args.adapterType).toBe("claude");
  });

  it("defaults the adapter type to null when the caller omits it", () => {
    const args = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
    });

    expect(args.adapterType).toBeNull();
  });

  it("passes the target agent through to the lease agent and defaults to null", () => {
    const withAgent = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
      targetAgentId: "agent-7",
    });
    expect(withAgent.agentId).toBe("agent-7");

    const withoutAgent = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
    });
    expect(withoutAgent.agentId).toBeNull();
  });

  it("passes the company-binding assertion through and leaves it unset by default", () => {
    const asserted = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
      assertCompanyBinding: true,
    });
    expect(asserted.assertCompanyBinding).toBe(true);

    const unset = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
    });
    expect(unset.assertCompanyBinding).toBeUndefined();
  });

  it("passes the requested expiry through and defaults to null", () => {
    const deadline = new Date("2026-01-01T00:00:00.000Z");
    const bounded = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
      requestedExpiresAt: deadline,
    });
    expect(bounded.requestedExpiresAt).toBe(deadline);

    const unbounded = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
    });
    expect(unbounded.requestedExpiresAt).toBeNull();
  });
});
