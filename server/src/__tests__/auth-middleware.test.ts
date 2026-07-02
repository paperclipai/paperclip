import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
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

function createDb(selectRows: unknown[][]) {
  let selectIndex = 0;
  return {
    select: () => createSelectChain(selectRows[selectIndex++] ?? []),
  } as any;
}

function createApp(selectRows: unknown[][]) {
  const app = express();
  app.use(actorMiddleware(createDb(selectRows), { deploymentMode: "local_trusted" }));
  app.post("/probe", (req, res) => res.json({ actor: req.actor }));
  return app;
}

describe("actor middleware", () => {
  it("resolves local trusted run headers to the run agent without bearer auth", async () => {
    const app = createApp([
      [{ id: "run-1", agentId: "agent-1", companyId: "company-1" }],
      [{ id: "agent-1", companyId: "company-1", status: "active" }],
    ]);

    const res = await request(app).post("/probe").set("X-Paperclip-Run-Id", "run-1");

    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "local_run_header",
    });
  });

  it.each([
    ["missing run", [[]]],
    [
      "cross-company agent",
      [
        [{ id: "run-1", agentId: "agent-1", companyId: "company-1" }],
        [{ id: "agent-1", companyId: "company-2", status: "active" }],
      ],
    ],
    [
      "terminated agent",
      [
        [{ id: "run-1", agentId: "agent-1", companyId: "company-1" }],
        [{ id: "agent-1", companyId: "company-1", status: "terminated" }],
      ],
    ],
    [
      "pending approval agent",
      [
        [{ id: "run-1", agentId: "agent-1", companyId: "company-1" }],
        [{ id: "agent-1", companyId: "company-1", status: "pending_approval" }],
      ],
    ],
  ])("falls back to local board actor for %s", async (_name, selectRows) => {
    const res = await request(createApp(selectRows)).post("/probe").set("X-Paperclip-Run-Id", "run-1");

    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "board",
      userId: "local-board",
      runId: "run-1",
      source: "local_implicit",
    });
  });
});
