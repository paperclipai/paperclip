import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../middleware/index.js";
import { assertBoard, assertBoardOrgAccess, BOARD_ACCESS_REQUIRED_CODE } from "../routes/authz.js";
import { AGENT_CHAT_DIRECTIVE } from "../services/agent-conversations.js";
import { buildOpenApiDocument } from "../routes/openapi.js";

const COMPANY_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";

const agentActor: Express.Request["actor"] = { type: "agent", source: "agent_key", agentId: "agent-1", companyId: COMPANY_ID };
const boardActor: Express.Request["actor"] = { type: "board", source: "local_implicit", userId: "local-board" };

function createApp(actor: Express.Request["actor"], guard = assertBoard) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  const router = express.Router();
  router.all(/.*/, (req, res) => {
    guard(req);
    res.json({ ok: true });
  });
  app.use("/api", router);
  app.use(errorHandler);
  return app;
}

describe("board-only denial", () => {
  it.each([
    ["post", `/api/companies/${COMPANY_ID}/archive`, "[Open company settings](/<prefix>/company/settings)"],
    ["post", `/api/companies/${COMPANY_ID}/secrets`, "[Open company secrets](/<prefix>/company/settings/secrets)"],
    ["post", `/api/secrets/${AGENT_ID}/rotate`, "[Open company secrets](/<prefix>/company/settings/secrets)"],
    ["post", `/api/companies/${COMPANY_ID}/budget-incidents/i-1/resolve?x=1`, "[Open budgets](/<prefix>/activity/budgets)"],
    ["post", `/api/companies/${COMPANY_ID}/costs/retry-accounting`, "[Open costs](/<prefix>/activity/costs)"],
    ["put", `/api/companies/${COMPANY_ID}/prompt-injection-prevention`, "[Open connection settings](/<prefix>/company/settings/connections)"],
    ["patch", `/api/agents/${AGENT_ID}/permissions`, `[Open the agent's permissions](/<prefix>/agents/${AGENT_ID}/permissions)`],
    ["post", `/api/agents/${AGENT_ID}/keys`, `[Open the agent's API keys](/<prefix>/agents/${AGENT_ID}/api-keys)`],
    ["post", `/api/agents/${AGENT_ID}/pause`, `[Open the agent's profile](/<prefix>/agents/${AGENT_ID})`],
    ["get", "/api/plugins", "[Open plugin settings](/<prefix>/company/settings/instance/plugins)"],
    ["post", "/api/plugins/install", "[Open plugin settings](/<prefix>/company/settings/instance/plugins)"],
    ["post", `/api/plugins/${AGENT_ID}/config`, `[Open the plugin's settings](/<prefix>/company/settings/instance/plugins/${AGENT_ID})`],
    ["post", "/api/plugins/acme.website-preview/disable", "[Open the plugin's settings](/<prefix>/company/settings/instance/plugins/acme.website-preview)"],
    ["post", "/api/plugins/my-plugin/config", "[Open the plugin's settings](/<prefix>/company/settings/instance/plugins/my-plugin)"],
    ["post", "/api/plugins/tools/execute", "[Open plugin settings](/<prefix>/company/settings/instance/plugins)"],
    ["get", "/api/plugins/ui-contributions", "[Open plugin settings](/<prefix>/company/settings/instance/plugins)"],
    ["post", `/api/projects/${AGENT_ID}/access-members`, `[Open the project's access settings](/<prefix>/projects/${AGENT_ID}/configuration)`],
    ["delete", `/api/projects/${AGENT_ID}/access-members/m-1`, `[Open the project's access settings](/<prefix>/projects/${AGENT_ID}/configuration)`],
    ["get", `/api/companies/${COMPANY_ID}/environments`, "[Open environment settings](/<prefix>/company/settings/instance/environments)"],
    ["get", `/api/companies/${COMPANY_ID}/environments/capabilities`, "[Open environment settings](/<prefix>/company/settings/instance/environments)"],
    ["post", `/api/environments/${AGENT_ID}/probe`, "[Open environment settings](/<prefix>/company/settings/instance/environments)"],
    ["get", `/api/environment-leases/${AGENT_ID}`, "[Open environment settings](/<prefix>/company/settings/instance/environments)"],
    ["get", `/api/environment-custom-image-setup-sessions/${AGENT_ID}`, "[Open environment settings](/<prefix>/company/settings/instance/environments)"],
    ["get", "/api/instance/settings/experimental", "[Open Experimental settings](/<prefix>/company/settings/instance/experimental)"],
    ["patch", "/api/instance/settings/experimental", "[Open Experimental settings](/<prefix>/company/settings/instance/experimental)"],
  ] as const)("tells an agent %s %s is final and names the board page", async (method, path, link) => {
    const res = await request(createApp(agentActor))[method](path).expect(403);
    expect(res.body.error).toBe("Board access required");
    expect(res.body.code).toBe(BOARD_ACCESS_REQUIRED_CODE);
    expect(res.body.remediation).toContain("this denial is final");
    expect(res.body.remediation).toContain("do not search for one");
    expect(res.body.remediation).toContain("reply now");
    expect(res.body.remediation).toContain(link);
  });

  it("tells an agent denied any plugin route that every plugin management step is board-only", async () => {
    // An agent asked to finish configuring a plugin usually reads the plugin list first.
    // That denial must also settle configuration and secret binding, or the agent keeps
    // searching the catalog for an agent route to them.
    for (const path of ["/api/plugins", `/api/plugins/${AGENT_ID}/config`]) {
      const res = await request(createApp(agentActor)).get(path).expect(403);
      expect(res.body.remediation).toContain("Plugin management is board-only throughout");
      expect(res.body.remediation).toContain("configuring (including choosing a secret for a plugin setting)");
    }
    const other = await request(createApp(agentActor)).post(`/api/companies/${COMPANY_ID}/secrets`).expect(403);
    expect(other.body.remediation).not.toContain("Plugin management");
  });

  it("links the resolved project when an agent names the project by its short reference", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = agentActor;
      next();
    });
    const router = express.Router();
    router.param("id", (req, _res, next, rawId) => {
      req.params.id = rawId === "acquisition" ? AGENT_ID : rawId;
      next();
    });
    router.post("/projects/:id/access-members", (req, res) => {
      assertBoard(req);
      res.json({ ok: true });
    });
    app.use("/api", router);
    app.use(errorHandler);
    const resolved = await request(app).post("/api/projects/acquisition/access-members").expect(403);
    expect(resolved.body.remediation).toContain(`[Open the project's access settings](/<prefix>/projects/${AGENT_ID}/configuration)`);
    const unresolved = await request(app).post("/api/projects/unknown-project/access-members").expect(403);
    expect(unresolved.body.remediation).toContain("Link a page only if you already know its route");
    expect(unresolved.body.remediation).not.toContain("](/");
  });

  it("falls back to a general board instruction when no page is known", async () => {
    const res = await request(createApp(agentActor)).get(`/api/companies/${COMPANY_ID}/managed-agent-profiles`).expect(403);
    expect(res.body.code).toBe(BOARD_ACCESS_REQUIRED_CODE);
    expect(res.body.remediation).toContain("this denial is final");
    expect(res.body.remediation).toContain("Paperclip web app or with their own board credentials");
    expect(res.body.remediation).toContain("Link a page only if you already know its route; do not search for one");
    expect(res.body.remediation).not.toContain("](/");
  });

  it("does not link connection settings for fast responses, whose controls an experiment can hide", async () => {
    const res = await request(createApp(agentActor)).put(`/api/companies/${COMPANY_ID}/fast-response`).expect(403);
    expect(res.body.remediation).not.toContain("/company/settings/connections");
  });

  it("does not link plugin settings while the operator hides plugin management", async () => {
    const previous = process.env.PAPERCLIP_HIDDEN_SETTINGS;
    process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.plugins";
    try {
      const res = await request(createApp(agentActor)).post(`/api/plugins/${AGENT_ID}/config`).expect(403);
      expect(res.body.remediation).toContain("this denial is final");
      expect(res.body.remediation).not.toContain("/instance/plugins");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_HIDDEN_SETTINGS;
      else process.env.PAPERCLIP_HIDDEN_SETTINGS = previous;
    }
  });

  it("tells an agent denied an environment route that testing and changing computers are board-only too", async () => {
    const res = await request(createApp(agentActor, assertBoardOrgAccess)).get(`/api/companies/${COMPANY_ID}/environments/capabilities`).expect(403);
    expect(res.body.remediation).toContain("Execution environments are board-only throughout");
    expect(res.body.remediation).toContain("testing (probing) them");
    const other = await request(createApp(agentActor)).get(`/api/companies/${COMPANY_ID}/project-environments`).expect(403);
    expect(other.body.remediation).not.toContain("Execution environments");
    expect(other.body.remediation).not.toContain("/instance/environments");
  });

  it("does not link environment settings while the operator hides them", async () => {
    const previous = process.env.PAPERCLIP_HIDDEN_SETTINGS;
    process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.environments";
    try {
      const res = await request(createApp(agentActor)).get(`/api/companies/${COMPANY_ID}/environments`).expect(403);
      expect(res.body.remediation).toContain("this denial is final");
      expect(res.body.remediation).not.toContain("/instance/environments");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_HIDDEN_SETTINGS;
      else process.env.PAPERCLIP_HIDDEN_SETTINGS = previous;
    }
  });

  it("does not link Experimental settings while the operator hides that page", async () => {
    const previous = process.env.PAPERCLIP_HIDDEN_SETTINGS;
    process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.experimental";
    try {
      const res = await request(createApp(agentActor)).patch("/api/instance/settings/experimental").expect(403);
      expect(res.body.remediation).toContain("this denial is final");
      expect(res.body.remediation).not.toContain("/instance/experimental");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_HIDDEN_SETTINGS;
      else process.env.PAPERCLIP_HIDDEN_SETTINGS = previous;
    }
  });

  it("applies through the org-access guard", async () => {
    const res = await request(createApp(agentActor, assertBoardOrgAccess)).delete(`/api/companies/${COMPANY_ID}`).expect(403);
    expect(res.body.code).toBe(BOARD_ACCESS_REQUIRED_CODE);
    expect(res.body.remediation).toContain("[Open company settings](/<prefix>/company/settings)");
  });

  it("keeps the plain denial for actors that are not agents", async () => {
    const res = await request(createApp({ type: "none", source: "none" })).post(`/api/companies/${COMPANY_ID}/archive`).expect(403);
    expect(res.body).toEqual({ error: "Board access required" });
    await request(createApp(boardActor)).post(`/api/companies/${COMPANY_ID}/archive`).expect(200);
  });

  it("chat guidance treats a board-only operation as final", () => {
    expect(AGENT_CHAT_DIRECTIVE).toContain("its API catalog authorization actor is board, or a call returns 403 \"Board access required\"");
    expect(AGENT_CHAT_DIRECTIVE).toContain("that boundary is final");
    expect(AGENT_CHAT_DIRECTIVE).toContain("so stop searching for one");
    expect(AGENT_CHAT_DIRECTIVE).toContain("tell the person which control in the Paperclip web app to use, link its page when you know the route");
    expect(AGENT_CHAT_DIRECTIVE).not.toContain("use permitted discovery to identify the supported operator path");
    expect(AGENT_CHAT_DIRECTIVE).toContain("Reply now instead of making more calls");
    expect(AGENT_CHAT_DIRECTIVE).not.toContain("Complete other permitted work");
  });

  it("chat guidance sends a task whose automatic recovery stopped to the person's Retry", () => {
    expect(AGENT_CHAT_DIRECTIVE).toContain("its supported next step is the person's Retry on that task");
    expect(AGENT_CHAT_DIRECTIVE).toContain("Retry rechecks the task's current gates (budget, pause, holds) and keeps the failed attempt's evidence");
    expect(AGENT_CHAT_DIRECTIVE).toContain("Do not reassign it, change its status, comment on it to resume it, or create a replacement task to re-run the work");
    expect(AGENT_CHAT_DIRECTIVE).toContain("Take the work over only when the person explicitly asks you to take it over or reassign it.");
  });

  it("says in the API catalog who sets up a Claude Managed Agent profile", () => {
    const post = buildOpenApiDocument().paths["/api/companies/{companyId}/managed-agent-profiles"].post;
    expect(post["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(post.description).toContain("Board only: agent credentials get 403");
    expect(post.description).toContain("explicitly acknowledges stateful retention");
  });
});
