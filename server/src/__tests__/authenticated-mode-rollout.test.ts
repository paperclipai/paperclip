import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { authenticatedApiGuard } from "../app.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { healthRoutes } from "../routes/health.js";
import { resolveDeploymentMode } from "../config.js";
import type { Db } from "@paperclipai/db";

function withActor(actor: Request["actor"]) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(authenticatedApiGuard({ deploymentMode: "authenticated" }));
  app.get("/companies", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

function withRealActorMiddleware(opts: {
  deploymentMode: "authenticated" | "local_trusted";
  agentRecord?: { id: string; companyId: string; status: string };
}) {
  const selectResults = opts.agentRecord
    ? [[], [], [opts.agentRecord]]
    : [[], []];
  const db = {
    select: () => {
      const result = selectResults.shift() ?? [];
      const query = {
        from: () => query,
        where: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
      };
      return query;
    },
  } as unknown as Db;
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: opts.deploymentMode }));
  app.use("/api", authenticatedApiGuard({ deploymentMode: opts.deploymentMode }));
  app.use("/api/health", healthRoutes(undefined, {
    deploymentMode: opts.deploymentMode,
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  }));
  app.get("/api/companies", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe("authenticated agent-host rollout", () => {
  it("rejects anonymous API reads with 401", async () => {
    const res = await request(withActor({ type: "none", source: "none" })).get("/companies");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("passes an authenticated agent request through unchanged", async () => {
    const res = await request(withActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
    })).get("/companies");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("defaults hosts to authenticated mode while preserving an explicit local-trusted override", () => {
    expect(resolveDeploymentMode({})).toBe("authenticated");
    expect(resolveDeploymentMode({ envValue: "local_trusted" })).toBe("local_trusted");
  });

  it("enforces the assembled actor-to-API boundary while preserving health and local-trusted paths", async () => {
    const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "authenticated-mode-test-secret";
    try {
      const agentToken = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
      expect(agentToken).toBeTruthy();

      const authenticatedApp = withRealActorMiddleware({
        deploymentMode: "authenticated",
        agentRecord: { id: "agent-1", companyId: "company-1", status: "active" },
      });
      const anonymous = await request(authenticatedApp).get("/api/companies");
      const agent = await request(authenticatedApp)
        .get("/api/companies")
        .set("Authorization", `Bearer ${agentToken}`);
      const health = await request(authenticatedApp).get("/api/health");

      expect(anonymous.status).toBe(401);
      expect(agent.status).toBe(200);
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: "ok", deploymentMode: "authenticated" });

      const localTrusted = await request(withRealActorMiddleware({ deploymentMode: "local_trusted" }))
        .get("/api/companies");
      expect(localTrusted.status).toBe(200);
    } finally {
      if (previousAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });
});
