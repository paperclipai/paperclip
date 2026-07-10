import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { readOnlyAgentMutationGuard } from "../middleware/read-only-agent-guard.js";
import { agentExecutionAccess } from "../services/agent-execution-access.js";

function appFor(input: { readOnly: boolean }) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      readOnly: input.readOnly,
      source: "agent_jwt",
    };
    next();
  });
  app.use(readOnlyAgentMutationGuard());
  app.get("/resource", (_req, res) => res.json({ ok: true }));
  app.post("/resource", (_req, res) => res.status(201).json({ created: true }));
  return app;
}

describe("readOnlyAgentMutationGuard", () => {
  it("recognizes read-only managed agent metadata", () => {
    expect(agentExecutionAccess({ pluginManagedAgent: { executionAccess: "readOnly" } })).toBe("read_only");
    expect(agentExecutionAccess({ pluginManagedAgent: { executionAccess: "readWrite" } })).toBe("read_write");
  });

  it("allows safe reads", async () => {
    const response = await request(appFor({ readOnly: true })).get("/resource");
    expect(response.status).toBe(200);
  });

  it("rejects mutations before route handlers run", async () => {
    const response = await request(appFor({ readOnly: true })).post("/resource");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "agent_read_only" });
  });

  it("does not change normal agent behavior", async () => {
    const response = await request(appFor({ readOnly: false })).post("/resource");
    expect(response.status).toBe(201);
  });
});
