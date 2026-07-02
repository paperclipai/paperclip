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

describe("actor middleware", () => {
  it("resolves local trusted run headers to the run agent without bearer auth", async () => {
    const db = createDb([
      [{ id: "run-1", agentId: "agent-1", companyId: "company-1" }],
      [{ id: "agent-1", companyId: "company-1", status: "active" }],
    ]);
    const app = express();

    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.post("/probe", (req, res) => res.json({ actor: req.actor }));

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
});
