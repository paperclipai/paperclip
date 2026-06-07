import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// AGNB access gate is exercised elsewhere — stub it so these tests focus on the
// route's own validation.
function registerModuleMocks() {
  vi.doMock("../routes/authz.js", () => ({
    assertAgnbAccess: vi.fn(),
  }));
}

type ExecuteMock = ReturnType<typeof vi.fn>;

async function createApp(execute: ExecuteMock) {
  registerModuleMocks();
  const { registerMarketing } = await import("../agnb/groups/marketing.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "user-1" } as never;
    next();
  });
  const router = express.Router();
  registerMarketing(router, { execute } as never);
  app.use("/api", router);
  return app;
}

const VALID_CREATE = {
  title: "Healthcare pitch",
  stage: "awareness",
  kind: "one_pager",
  html: "<div class=\"body\">Hi {{customer_name}}</div>",
};

describe("POST /api/agnb/marketing — create validation", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("rejects an out-of-set stage with 400 and never touches the db", async () => {
    const execute = vi.fn();
    const app = await createApp(execute);
    const res = await request(app).post("/api/agnb/marketing").send({ ...VALID_CREATE, stage: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "invalid stage" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an out-of-set status with 400", async () => {
    const execute = vi.fn();
    const app = await createApp(execute);
    const res = await request(app).post("/api/agnb/marketing").send({ ...VALID_CREATE, status: "published" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid status");
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts a valid stage + status and inserts", async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: "asset-9" }] }));
    const app = await createApp(execute);
    const res = await request(app).post("/api/agnb/marketing").send({ ...VALID_CREATE, status: "active" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: "asset-9" });
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("PATCH /api/agnb/marketing — update validation", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("rejects an out-of-set stage with 400", async () => {
    const execute = vi.fn();
    const app = await createApp(execute);
    const res = await request(app).patch("/api/agnb/marketing?id=asset-1").send({ stage: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid stage");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an out-of-set status with 400", async () => {
    const execute = vi.fn();
    const app = await createApp(execute);
    const res = await request(app).patch("/api/agnb/marketing?id=asset-1").send({ status: "live" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid status");
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts a valid partial update (status only)", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const app = await createApp(execute);
    const res = await request(app).patch("/api/agnb/marketing?id=asset-1").send({ status: "archived" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledOnce();
  });
});
