import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  agentApiKeys, agents, authUsers, boardApiKeys, companyMemberships,
} from "@paperclipai/db";
import type { CronServiceAgentKeyScope } from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { cronServiceKeyGuard } from "../middleware/cron-service-key.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyId = "ac917a45-e6ea-4696-a85c-991147084939";
const agentId = "94906724-4190-4b53-9393-66148d453477";
const issueId = "7f82bd2d-f408-4e8f-98aa-d54b5a58903b";
const pixelAgentId = "f0ddf9c0-d0cf-4a44-8b0b-c2167232852e";
const key = "pc_cron_synthetic_value_never_logged";

function appFor(scope: unknown) {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === boardApiKeys) return [];
          if (table === agentApiKeys) return [{
            id: issueId, agentId, companyId, keyHash: createHash("sha256").update(key).digest("hex"),
            revokedAt: null, responsibleUserId: "operator", scopeConfig: scope,
          }];
          if (table === agents) return [{ id: agentId, companyId, status: "idle" }];
          if (table === authUsers) return [{ id: "operator" }];
          if (table === companyMemberships) return [{ companyId, membershipRole: "owner", status: "active" }];
          return [];
        },
      }),
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as any;
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.use(cronServiceKeyGuard(db));
  app.use("/api", (_req, res) => res.json({ allowed: true }));
  app.use(errorHandler);
  return app;
}

describe("synthetic HTTP boundary for cron identities", () => {
  it("allows each cron's required API operation and denies a prohibited operation", async () => {
    const cases: Array<{ scope: CronServiceAgentKeyScope; method: "get" | "post"; path: string; body?: object }> = [
      {
        scope: { kind: "cron_service", service: "agent_watchdog", alarmIssueIds: [issueId] },
        method: "get", path: `/api/companies/${companyId}/agents`,
      },
      {
        scope: { kind: "cron_service", service: "quota_rewake" },
        method: "post", path: `/api/companies/${companyId}/issues`,
        body: { title: "[quota-rewake] operator: return", description: "quota restored", status: "todo", assigneeAgentId: pixelAgentId },
      },
    ];
    for (const candidate of cases) {
      const app = appFor(candidate.scope);
      const allowed = request(app)[candidate.method](candidate.path).set("Authorization", `Bearer ${key}`);
      const allowedResponse = await (candidate.body ? allowed.send(candidate.body) : allowed);
      expect(allowedResponse.status, candidate.scope.service).toBe(200);
      expect(allowedResponse.body).toEqual({ allowed: true });
      const forbidden = await request(app).get(`/api/agents/${agentId}/keys`).set("Authorization", `Bearer ${key}`);
      expect(forbidden.status, candidate.scope.service).toBe(403);
      expect(JSON.stringify(forbidden.body)).not.toContain(key);
    }
  });

  it("fails closed for a future scope instead of treating it as standard", async () => {
    const response = await request(appFor({ kind: "future_scope" }))
      .get(`/api/companies/${companyId}/agents`)
      .set("Authorization", `Bearer ${key}`);
    expect(response.status).toBe(403);
  });

  it("rejects the removed deploy service scope on the HTTP boundary", async () => {
    const response = await request(appFor({
      kind: "cron_service", service: "deploy_frontend", projectId: companyId, assigneeAgentId: pixelAgentId,
    })).post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${key}`)
      .send({ title: "🔴 Фронт-деплой: injected", description: "agent-controlled" });
    expect(response.status).toBe(403);
  });
});
