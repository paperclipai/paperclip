import { describe, expect, it } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { assertWatchdogServiceRequest } from "../middleware/watchdog-service-request.js";

describe("watchdog request without a verified run", () => {
  it("fails closed when the authenticated JWT lacks run identity", async () => {
    const req = { actor: { type: "agent", source: "agent_jwt", agentId: "agent", companyId: "company" } } as Request;
    await expect(assertWatchdogServiceRequest({} as Db, req)).rejects.toMatchObject({ status: 403 });
  });
});
