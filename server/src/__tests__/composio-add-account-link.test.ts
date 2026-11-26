import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  issues,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/error-handler.js";
import { composioAddAccountLink, composioAppSetupResult } from "../services/composio-app-setup.js";
import { toolAccessService } from "../services/tool-access.js";
import { aggregatorAppTelemetrySlug } from "../services/connector-telemetry.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const track = vi.fn();
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({
    track,
    isRegisteredEventName: () => true,
    hashPrivateRef: (value: string) => value,
    trackDynamic: vi.fn(),
  }),
}));
const appRequestedEvents = () => track.mock.calls.filter(([name]) => name === "connection.app_requested");

describe("Composio add-account link", () => {
  const response = {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          data: {
            results: {
              gmail: {
                toolkit: "gmail",
                status: "active",
                accounts: [{ id: "ca_1", status: "active" }],
                redirect_url: "https://connect.composio.dev/link/next",
              },
            },
          },
          error: null,
          successful: true,
        }),
      }],
      isError: false,
    },
  };

  it("returns the new account's link even when the toolkit already has an active account", () => {
    expect(composioAppSetupResult(response, "gmail")).toEqual({ status: "connected" });
    expect(composioAddAccountLink(response)).toBe("https://connect.composio.dev/link/next");
  });

  it("returns no link without a trusted hosted link and rejects provider failures", () => {
    expect(composioAddAccountLink({ results: { gmail: { status: "active" } } })).toBeNull();
    expect(composioAddAccountLink({ results: { gmail: { redirect_url: "https://untrusted.example/link/next" } } })).toBeNull();
    expect(() => composioAddAccountLink({ isError: true })).toThrow("could not configure");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("POST /api/tool-connections/:connectionId/composio/apps/:toolkit/accounts (add)", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-composio-add-account-");
    db = createDb(database.connectionString);
    cleanup = database.cleanup;
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  async function setupComposioRouteFixture(respond: (requestId: string, toolkits: { name: string; action: string }[]) => Response) {
    const [company] = await db.insert(companies).values({
      name: "Composio add-account test",
      issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
    }).returning();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      membershipRole: "admin",
      status: "active",
    });
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Default agent",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: randomUUID(),
      name: "Composio",
      type: "mcp_http",
      metadata: { sourceTemplateKey: "composio" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      uid: randomUUID(),
      name: "Composio account",
      transport: "mcp_remote",
      authKind: "none",
      credentialPolicy: "shared",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "composio", url: "https://connect.composio.dev/mcp" },
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: connection.id,
      kind: "organization",
      isDefault: true,
      status: "active",
    });
    await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      connectionId: connection.id,
      name: "COMPOSIO_MANAGE_CONNECTIONS",
      toolName: "COMPOSIO_MANAGE_CONNECTIONS",
      versionHash: "v1",
      status: "active",
      riskLevel: "destructive",
    });

    const operations: { name: string; action: string }[] = [];
    const remoteHttpRequest: NonNullable<Parameters<typeof toolAccessService>[1]>["remoteHttpRequest"] = async (_url, init) => {
      const rpc = JSON.parse(String(init.body));
      expect(rpc.params.name).toBe("COMPOSIO_MANAGE_CONNECTIONS");
      const toolkits = rpc.params.arguments.toolkits as { name: string; action: string }[];
      operations.push(...toolkits);
      return respond(rpc.id, toolkits);
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId,
        source: "session",
        isInstanceAdmin: false,
        companyIds: [company.id],
      };
      next();
    });
    app.use("/api", toolAccessRoutes(db, { remoteHttpRequest }));
    app.use(errorHandler);

    return {
      company,
      agent,
      connection,
      operations,
      app,
      access: toolAccessService(db, { remoteHttpRequest }),
    };
  }

  it("returns the new sign-in link when Gmail already has an active account", async () => {
    const f = await setupComposioRouteFixture((id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              data: {
                results: {
                  gmail: {
                    toolkit: "gmail",
                    status: "active",
                    accounts: [{ id: "ca_1", alias: "Work", status: "active", is_default: true }],
                    redirect_url: "https://connect.composio.dev/link/next",
                  },
                },
              },
              error: null,
              successful: true,
            }),
          }],
          isError: false,
        },
      }),
    );

    track.mockClear();
    const response = await request(f.app)
      .post(`/api/tool-connections/${f.connection.id}/composio/apps/gmail/accounts`)
      .send({ action: "add" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "authorization_required",
      authorizationUrl: "https://connect.composio.dev/link/next",
      apps: [],
    });
    expect(f.operations).toEqual([{ name: "gmail", action: "add" }]);
    expect(appRequestedEvents()).toEqual([
      ["connection.app_requested", {
        provider: "composio",
        app: aggregatorAppTelemetrySlug("composio", "gmail"),
        origin: "user",
        outcome: "needs_auth",
      }],
    ]);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toHaveLength(0);
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools).toEqual([]);
  });

  it("returns 422 and failed telemetry when Composio returns no trusted link or reports a provider error", async () => {
    const missingLink = await setupComposioRouteFixture((id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          structuredContent: {
            data: {
              results: {
                gmail: {
                  toolkit: "gmail",
                  status: "active",
                  accounts: [{ id: "ca_1", status: "ACTIVE" }],
                },
              },
            },
          },
        },
      }),
    );

    track.mockClear();
    const missingResponse = await request(missingLink.app)
      .post(`/api/tool-connections/${missingLink.connection.id}/composio/apps/gmail/accounts`)
      .send({ action: "add" });
    expect(missingResponse.status).toBe(422);
    expect(missingResponse.body.error).toContain("did not return a sign-in link");
    expect(appRequestedEvents()).toEqual([
      ["connection.app_requested", {
        provider: "composio",
        app: aggregatorAppTelemetrySlug("composio", "gmail"),
        origin: "user",
        outcome: "failed",
      }],
    ]);

    const untrustedLink = await setupComposioRouteFixture((id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          structuredContent: {
            data: {
              results: {
                gmail: {
                  toolkit: "gmail",
                  redirect_url: "https://untrusted.example/link/next",
                },
              },
            },
          },
        },
      }),
    );

    track.mockClear();
    const untrustedResponse = await request(untrustedLink.app)
      .post(`/api/tool-connections/${untrustedLink.connection.id}/composio/apps/gmail/accounts`)
      .send({ action: "add" });
    expect(untrustedResponse.status).toBe(422);
    expect(untrustedResponse.body.error).toContain("did not return a sign-in link");
    expect(appRequestedEvents()).toEqual([
      ["connection.app_requested", {
        provider: "composio",
        app: aggregatorAppTelemetrySlug("composio", "gmail"),
        origin: "user",
        outcome: "failed",
      }],
    ]);

    const providerError = await setupComposioRouteFixture((id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: "error" }],
        },
      }),
    );

    track.mockClear();
    const errorResponse = await request(providerError.app)
      .post(`/api/tool-connections/${providerError.connection.id}/composio/apps/gmail/accounts`)
      .send({ action: "add" });
    expect(errorResponse.status).toBe(422);
    expect(errorResponse.body.error).toContain("could not configure");
    expect(appRequestedEvents()).toEqual([
      ["connection.app_requested", {
        provider: "composio",
        app: aggregatorAppTelemetrySlug("composio", "gmail"),
        origin: "user",
        outcome: "failed",
      }],
    ]);
  });
});
