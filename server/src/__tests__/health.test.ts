import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Db } from "@paperclipai/db";

async function createHealthApp(db?: Db) {
  vi.resetModules();
  const [{ default: express }, devServerStatus] = await Promise.all([
    import("express"),
    import("../dev-server-status.js"),
  ]);
  vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
  const [{ healthRoutes }, { serverVersion }] = await Promise.all([
    import("../routes/health.js"),
    import("../version.js"),
  ]);
  const app = express();
  app.use("/health", healthRoutes(db));
  return { app, serverVersion };
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with status ok", async () => {
    const { app, serverVersion } = await createHealthApp();

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const { app, serverVersion } = await createHealthApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const { app, serverVersion } = await createHealthApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
    });
  });
});
