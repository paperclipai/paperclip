import { describe, expect, it } from "vitest";
import { accessService } from "../services/access.js";

describe("services/access.ts", () => {
  it("returns false for canUser when no userId is provided", async () => {
    const service = accessService({} as any);
    await expect(service.canUser("cmp-1", null, "agent.create")).resolves.toBe(false);
  });

  it("exposes access service methods", () => {
    const service = accessService({} as any);
    expect(service).toMatchObject({
      canUser: expect.any(Function),
      hasPermission: expect.any(Function),
      ensureMembership: expect.any(Function),
      setPrincipalPermission: expect.any(Function),
    });
  });
});

