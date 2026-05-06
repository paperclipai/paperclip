import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb(selectRows: unknown[][] = [[], []]) {
  return {
    select: vi
      .fn()
      .mockImplementation(() => createSelectChain(selectRows.shift() ?? [])),
  } as any;
}

describe("actorMiddleware authenticated session profile", () => {
  const originalCloudTenantToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;

  afterEach(() => {
    if (originalCloudTenantToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = originalCloudTenantToken;
  });

  async function requestLocalTrustedActor(selectRows: unknown[][]) {
    const app = express();
    app.use(
      actorMiddleware(createDb(selectRows), {
        deploymentMode: "local_trusted",
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    return await request(app)
      .get("/actor")
      .set("X-Paperclip-Run-Id", "77777777-7777-4777-8777-777777777777");
  }

  it("preserves the signed-in user name and email on the board actor", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
  });

  it("trusts Cloud tenant identity headers and seeds board access", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    const inserts: Array<{ values: Record<string, unknown> }> = [];
    const db = {
      insert: vi.fn(() => {
        const chain = {
          values(values: Record<string, unknown>) {
            inserts.push({ values });
            return chain;
          },
          onConflictDoUpdate() {
            return chain;
          },
          onConflictDoNothing() {
            return chain;
          },
          returning() {
            return Promise.resolve([{
              companyId: inserts.at(-1)?.values.companyId,
              membershipRole: inserts.at(-1)?.values.membershipRole,
              status: inserts.at(-1)?.values.status,
            }]);
          },
        };
        return chain;
      }),
      select: vi.fn(),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-user-name", "Stack Owner")
      .set("x-paperclip-cloud-stack-id", "stack-alpha")
      .set("x-paperclip-cloud-paperclip-company-id", "paperclip-stack-alpha")
      .set("x-paperclip-cloud-stack-role", "owner");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "global-user-1",
      userName: "Stack Owner",
      userEmail: "owner@example.com",
      source: "cloud_tenant",
      isInstanceAdmin: true,
      memberships: [expect.objectContaining({ membershipRole: "owner", status: "active" })],
    });
    expect(res.body.companyIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserts).toHaveLength(4);
    expect(inserts[0]?.values).toMatchObject({
      id: "global-user-1",
      email: "owner@example.com",
      emailVerified: true,
    });
  });

  it("resolves local trusted run-id requests to the owning agent before route attribution", async () => {
    const res = await requestLocalTrustedActor([
        [{
          id: "77777777-7777-4777-8777-777777777777",
          agentId: "22222222-2222-4222-8222-222222222222",
          companyId: "11111111-1111-4111-8111-111111111111",
          status: "running",
        }],
        [{
          id: "22222222-2222-4222-8222-222222222222",
          companyId: "11111111-1111-4111-8111-111111111111",
          status: "active",
        }],
      ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "11111111-1111-4111-8111-111111111111",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      memberships: [],
      runId: "77777777-7777-4777-8777-777777777777",
      source: "agent_run_id",
    });
  });

  it("does not resolve local trusted run-id requests for inactive or mismatched runs", async () => {
    const cases: unknown[][][] = [
      [[]],
      [[{
        id: "77777777-7777-4777-8777-777777777777",
        agentId: null,
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "running",
      }]],
      [[{
        id: "77777777-7777-4777-8777-777777777777",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "done",
      }], [{
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "active",
      }]],
      [[{
        id: "77777777-7777-4777-8777-777777777777",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "running",
      }], [{
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "33333333-3333-4333-8333-333333333333",
        status: "active",
      }]],
      [[{
        id: "77777777-7777-4777-8777-777777777777",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "running",
      }], [{
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "terminated",
      }]],
      [[{
        id: "77777777-7777-4777-8777-777777777777",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "running",
      }], [{
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "pending_approval",
      }]],
      [[{
        id: "77777777-7777-4777-8777-777777777777",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "running",
      }], [{
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        status: "suspended",
      }]],
    ];

    for (const selectRows of cases) {
      const res = await requestLocalTrustedActor(selectRows);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        type: "board",
        source: "local_implicit",
        runId: "77777777-7777-4777-8777-777777777777",
      });
    }
  });
});
