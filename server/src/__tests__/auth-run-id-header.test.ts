import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

const KNOWN_RUN_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_RUN_ID = "22222222-2222-4222-8222-222222222222";

function createDb(runRows: Array<{ id: string }> = []) {
  const where = vi.fn(async () => runRows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return {
    db: { select },
    select,
    from,
    where,
  };
}

function createApp(db: unknown) {
  const app = express();
  app.use(
    actorMiddleware(db as never, {
      deploymentMode: "local_trusted",
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("actorMiddleware X-Paperclip-Run-Id handling", () => {
  it("rejects malformed run id headers before routes persist them", async () => {
    const harness = createDb([{ id: KNOWN_RUN_ID }]);

    const res = await request(createApp(harness.db)).get("/actor").set("X-Paperclip-Run-Id", "codex-run-1");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid X-Paperclip-Run-Id header");
    expect(harness.select).not.toHaveBeenCalled();
  });

  it("rejects UUID run id headers that do not point to a heartbeat run", async () => {
    const harness = createDb([]);

    const res = await request(createApp(harness.db)).get("/actor").set("X-Paperclip-Run-Id", UNKNOWN_RUN_ID);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown X-Paperclip-Run-Id header");
    expect(harness.select).toHaveBeenCalledOnce();
  });

  it("keeps known heartbeat run ids on the request actor", async () => {
    const harness = createDb([{ id: KNOWN_RUN_ID }]);

    const res = await request(createApp(harness.db)).get("/actor").set("X-Paperclip-Run-Id", KNOWN_RUN_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "local-board",
      runId: KNOWN_RUN_ID,
      source: "local_implicit",
    });
  });
});
