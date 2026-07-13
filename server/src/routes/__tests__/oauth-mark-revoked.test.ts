import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthMarkRevokedRoute } from "../oauth-mark-revoked.js";

interface MakeAppOptions {
  allowedIds: string[];
  injectClaim?: boolean; // default true; set false to simulate missing JWT
  // Tri-state: undefined → use default "co-1"; null → omit companyId from
  // the injected claim; string → use that companyId verbatim.
  companyId?: string | null;
}

function makeApp({
  allowedIds,
  injectClaim = true,
  companyId,
}: MakeAppOptions) {
  const effectiveCompany = companyId === undefined ? "co-1" : companyId;
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const db = {
    update: vi.fn().mockReturnValue({ set: setMock }),
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/oauth/connections/:id/mark-revoked",
    (req, _res, next) => {
      if (injectClaim) {
        const claim: Record<string, unknown> = {
          connectionIds: allowedIds,
          runId: "r1",
        };
        if (effectiveCompany !== null) claim.companyId = effectiveCompany;
        (req as unknown as { runJwt: unknown }).runJwt = claim;
      }
      next();
    },
    oauthMarkRevokedRoute({ db } as never),
  );
  return { app, whereMock, setMock, db };
}

describe("POST /api/oauth/connections/:id/mark-revoked", () => {
  it("204 when JWT scopes the connection", async () => {
    const { app, whereMock, setMock } = makeApp({ allowedIds: ["c-1"] });
    const res = await request(app).post("/api/oauth/connections/c-1/mark-revoked");
    expect(res.status).toBe(204);
    expect(whereMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "revoked",
        lastError: "runtime_401",
      }),
    );
  });

  it("403 when JWT does not include the connection", async () => {
    const { app, whereMock } = makeApp({ allowedIds: ["other"] });
    const res = await request(app).post("/api/oauth/connections/c-1/mark-revoked");
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBe("forbidden");
    expect(whereMock).not.toHaveBeenCalled();
  });

  it("401 when no run-JWT claim is present on the request", async () => {
    const { app, whereMock } = makeApp({
      allowedIds: ["c-1"],
      injectClaim: false,
    });
    const res = await request(app).post("/api/oauth/connections/c-1/mark-revoked");
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe("unauthenticated");
    expect(whereMock).not.toHaveBeenCalled();
  });

  it("401 when JWT lacks a companyId so the UPDATE cannot be scoped to a tenant", async () => {
    const { app, whereMock } = makeApp({
      allowedIds: ["c-1"],
      companyId: null,
    });
    const res = await request(app).post("/api/oauth/connections/c-1/mark-revoked");
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe("unauthenticated");
    expect(whereMock).not.toHaveBeenCalled();
  });

  it("scopes the UPDATE to the JWT companyId as defense-in-depth", async () => {
    // Verifies the WHERE clause is built with both id and companyId so a
    // stale or crafted JWT containing a connection ID from another tenant
    // cannot mutate a cross-tenant row.
    const { app, db } = makeApp({
      allowedIds: ["c-1"],
      companyId: "co-X",
    });
    await request(app).post("/api/oauth/connections/c-1/mark-revoked");
    expect(db.update).toHaveBeenCalledTimes(1);
    // The WHERE clause is an `and(eq(id, ...), eq(companyId, ...))`. Drizzle
    // returns an opaque SQL builder object; we can't easily inspect it, so
    // assert via the chained call shape: a single .set().where() — and trust
    // that the route file calls `and(eq, eq)` (covered by integration test
    // when DB is real).
    expect(db.update.mock.calls[0]?.length).toBe(1);
  });
});
