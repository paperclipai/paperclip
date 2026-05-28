import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

const VALID_RUN_ID = "0190f8e2-7b6c-7c1f-9e7f-3d3f4a2b1c8a";

function emptyDb() {
  return {
    select: vi.fn(),
  } as unknown as Parameters<typeof actorMiddleware>[0];
}

function appWithMiddleware() {
  const app = express();
  app.use(
    actorMiddleware(emptyDb(), {
      deploymentMode: "local_trusted",
    }),
  );
  app.get("/actor", (req, res) => {
    res.json({ runId: req.actor.runId ?? null });
  });
  return app;
}

describe("actorMiddleware X-Paperclip-Run-Id validation", () => {
  it("accepts a canonical lowercase UUID header", async () => {
    const res = await request(appWithMiddleware())
      .get("/actor")
      .set("X-Paperclip-Run-Id", VALID_RUN_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: VALID_RUN_ID });
  });

  it("normalizes uppercase UUID headers to lowercase", async () => {
    const res = await request(appWithMiddleware())
      .get("/actor")
      .set("X-Paperclip-Run-Id", VALID_RUN_ID.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: VALID_RUN_ID });
  });

  it("allows the request through when the header is absent", async () => {
    const res = await request(appWithMiddleware()).get("/actor");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: null });
  });

  it("rejects the smoke-script label pattern with 400", async () => {
    const res = await request(appWithMiddleware())
      .get("/actor")
      .set("X-Paperclip-Run-Id", "smoke-run-1717000000");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "invalid_run_id",
      source: "header",
      got: "smoke-run-1717000000",
    });
  });

  it("rejects the manual session label pattern with 400", async () => {
    const res = await request(appWithMiddleware())
      .get("/actor")
      .set("X-Paperclip-Run-Id", "manual-smilerite-20260527T141106Z");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_run_id");
    expect(res.body.got).toBe("manual-smilerite-20260527T141106Z");
  });

  it("rejects an empty header with 400 (send the header or omit it)", async () => {
    // supertest collapses empty string headers; force one through with raw set
    const res = await request(appWithMiddleware())
      .get("/actor")
      .set("X-Paperclip-Run-Id", " ");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_run_id");
  });
});
