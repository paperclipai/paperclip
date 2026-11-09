import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { getAccessibleResource, issueNotFoundBody, ISSUE_NOT_VISIBLE_CODE } from "../routes/authz.js";
import { buildOpenApiDocument } from "../routes/openapi.js";
import { withMcpConnectionFailure } from "../services/mcp-connection-failure.js";
import { unreachableServerRemediation } from "../services/tool-access/catalog/failures.js";

const COMPANY_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_COMPANY_ID = "10000000-0000-4000-8000-000000000009";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000003";

const agentActor: Express.Request["actor"] = { type: "agent", source: "agent_key", agentId: "agent-1", companyId: COMPANY_ID };
const boardActor: Express.Request["actor"] = { type: "board", source: "local_implicit", userId: "local-board" };

function lookupApp(actor: Express.Request["actor"], issue: { companyId: string } | null) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.get("/api/issues/:id", async (req, res) => {
    const found = await getAccessibleResource(req, res, issue, "Issue not found", issueNotFoundBody(req));
    if (found) res.json(found);
  });
  app.use(errorHandler);
  return app;
}

async function refusedConnection(code: string) {
  return withMcpConnectionFailure(async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect failed"), { code }) });
  }).catch((error: unknown) => error);
}

describe("agent refusals that are final", () => {
  it("tells an agent a task lookup is final, with one body for missing and other-company tasks", async () => {
    const missing = await request(lookupApp(agentActor, null)).get("/api/issues/COM-2").expect(404);
    const otherCompany = await request(lookupApp(agentActor, { companyId: OTHER_COMPANY_ID })).get("/api/issues/OTH-1").expect(404);
    expect(missing.body).toEqual(otherCompany.body);
    expect(missing.body).toEqual(issueNotFoundBody({ actor: agentActor } as express.Request));
    expect(missing.body.error).toBe("Issue not found");
    expect(missing.body.code).toBe(ISSUE_NOT_VISIBLE_CODE);
    expect(missing.body.remediation).toContain("this lookup is final");
    expect(missing.body.remediation).toContain("do not open a similarly named task in its place");
    expect(missing.body.remediation).toContain("Reply now");
  });

  it("keeps the plain task 404 for people", async () => {
    const res = await request(lookupApp(boardActor, null)).get("/api/issues/COM-2").expect(404);
    expect(res.body).toEqual({ error: "Issue not found" });
  });

  it("tells an agent an unreachable MCP server is the person's to fix, and not to probe other addresses", async () => {
    const error = await refusedConnection("ECONNREFUSED");
    const { remediation } = unreachableServerRemediation(error, CONNECTION_ID, { actorType: "agent" }) as { remediation: string };
    expect(remediation).toContain("nothing accepted the connection");
    expect(remediation).toContain("they must correct the URL, or start the server");
    expect(remediation).toContain("you must not contact other hosts, ports or network addresses yourself");
    expect(remediation).toContain("Reply now");
    expect(remediation).toContain(`[Open the connection](/<prefix>/apps/${CONNECTION_ID}/permissions)`);
  });

  it("adds no MCP remediation for people or for failures that reached the server", async () => {
    const error = await refusedConnection("ECONNREFUSED");
    expect(unreachableServerRemediation(error, CONNECTION_ID, { actorType: "user" })).toEqual({});
    expect(unreachableServerRemediation(new Error("tool list was invalid"), CONNECTION_ID, { actorType: "agent" })).toEqual({});
  });

  it("returns the MCP remediation in the error body an agent receives", async () => {
    const source = await refusedConnection("ENOTFOUND");
    const routed = express();
    routed.post("/check", () => {
      throw new HttpError(502, "fetch failed", { code: "runtime_error", ...unreachableServerRemediation(source, CONNECTION_ID, { actorType: "agent" }) });
    });
    routed.use(errorHandler);
    const res = await request(routed).post("/check").expect(502);
    expect(res.body.code).toBe("runtime_error");
    expect(res.body.remediation).toContain("its host name did not resolve");
  });

  it("points the API catalog at the checked MCP setup route and the complete model lists", () => {
    const paths = buildOpenApiDocument().paths;
    expect(paths["/api/companies/{companyId}/tools/connections"].post.description).toContain("POST /api/companies/{companyId}/tools/apps/connect with link");
    const models = paths["/api/companies/{companyId}/adapters/{type}/models"].get;
    expect(models.description).toContain("type opencode_local and provider=openrouter");
    expect(models.description).toContain("These calls are the complete answer");
    const provider = models.parameters.find((row: { name: string }) => row.name === "provider");
    expect(provider.schema.enum).toContain("openrouter");
  });
});
