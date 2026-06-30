import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { wrapBetterAuthHandlerWithPasswordAudit, __testing__ } from "../auth/password-audit.js";

const { matchPasswordWritePath, normalizePath, resolveActorFields, resolveIpAddress, PASSWORD_WRITE_PATHS } =
  __testing__;

function mockRes(statusCode = 200): Response {
  return { statusCode } as unknown as Response;
}

function mockRequest(
  method: string,
  url: string,
  overrides: Partial<Request> = {},
): Request {
  return {
    method,
    originalUrl: url,
    url,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    ip: "127.0.0.1",
    actor: { type: "none", source: "none" },
    ...overrides,
  } as unknown as Request;
}

describe("password-audit: matchPasswordWritePath", () => {
  it("matches the canonical password-write endpoints on POST", () => {
    for (const path of PASSWORD_WRITE_PATHS) {
      expect(matchPasswordWritePath("POST", path)).toBe(path);
    }
  });

  it("matches POST paths with a trailing slash", () => {
    expect(matchPasswordWritePath("POST", "/api/auth/change-password/")).toBe(
      "/api/auth/change-password",
    );
  });

  it("strips a query string before matching", () => {
    expect(matchPasswordWritePath("POST", "/api/auth/reset-password?callback=/x")).toBe(
      "/api/auth/reset-password",
    );
  });

  it("rejects GET on password-write paths", () => {
    expect(matchPasswordWritePath("GET", "/api/auth/change-password")).toBeNull();
  });

  it("rejects unrelated auth endpoints", () => {
    expect(matchPasswordWritePath("POST", "/api/auth/sign-in/email")).toBeNull();
    expect(matchPasswordWritePath("POST", "/api/auth/get-session")).toBeNull();
    expect(matchPasswordWritePath("POST", "/api/auth/logout")).toBeNull();
  });

  it("rejects unknown paths that merely contain the substring", () => {
    expect(matchPasswordWritePath("POST", "/api/auth/change-password-legacy")).toBeNull();
    expect(matchPasswordWritePath("POST", "/api/v2/change-password")).toBeNull();
  });

  it("is case-insensitive on method", () => {
    expect(matchPasswordWritePath("post", "/api/auth/change-password")).toBe(
      "/api/auth/change-password",
    );
  });
});

describe("password-audit: normalizePath", () => {
  it("drops query strings", () => {
    expect(normalizePath("/api/auth/x?foo=bar")).toBe("/api/auth/x");
  });
  it("drops a single trailing slash but preserves root", () => {
    expect(normalizePath("/api/auth/x/")).toBe("/api/auth/x");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("password-audit: resolveActorFields", () => {
  it("returns none when actor is undefined", () => {
    expect(resolveActorFields(undefined)).toEqual({
      actorType: "none",
      actorUserId: null,
      actorAgentId: null,
      actorSource: null,
    });
  });

  it("extracts board actor fields", () => {
    expect(
      resolveActorFields({ type: "board", userId: "u-1", source: "session" }),
    ).toEqual({
      actorType: "board",
      actorUserId: "u-1",
      actorAgentId: null,
      actorSource: "session",
    });
  });

  it("extracts agent actor fields", () => {
    expect(
      resolveActorFields({ type: "agent", agentId: "a-1", source: "agent_jwt" }),
    ).toEqual({
      actorType: "agent",
      actorUserId: null,
      actorAgentId: "a-1",
      actorSource: "agent_jwt",
    });
  });
});

describe("password-audit: resolveIpAddress", () => {
  it("prefers the first X-Forwarded-For segment", () => {
    const req = mockRequest("POST", "/x", {
      headers: { "x-forwarded-for": "74.120.168.78, 10.0.0.1" },
    });
    expect(resolveIpAddress(req)).toBe("74.120.168.78");
  });

  it("falls back to socket.remoteAddress when no XFF header", () => {
    const req = mockRequest("POST", "/x");
    expect(resolveIpAddress(req)).toBe("127.0.0.1");
  });

  it("returns null when nothing is available", () => {
    const req = mockRequest("POST", "/x", {
      headers: {},
      socket: {},
      ip: undefined,
    });
    expect(resolveIpAddress(req)).toBeNull();
  });
});

describe("wrapBetterAuthHandlerWithPasswordAudit", () => {
  it("passes through non-password-write requests without instrumentation", async () => {
    const inner = vi.fn().mockImplementation((_req, res) => {
      res.statusCode = 200;
      return Promise.resolve();
    });
    const db = { insert: vi.fn(), update: vi.fn() };
    const wrapped = wrapBetterAuthHandlerWithPasswordAudit(inner as any, {
      db: db as any,
      enabled: true,
    });

    const req = mockRequest("POST", "/api/auth/sign-in/email");
    const res = mockRes();
    await runWrapper(wrapped, req, res);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("records an audit row and stamps account on a successful password write", async () => {
    const inner = vi.fn().mockImplementation((_req, res) => {
      res.statusCode = 200;
      return Promise.resolve();
    });
    const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
    const updateChain = { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) };
    const db = {
      insert: vi.fn().mockReturnValue(insertChain),
      update: vi.fn().mockReturnValue(updateChain),
    };
    const wrapped = wrapBetterAuthHandlerWithPasswordAudit(inner as any, {
      db: db as any,
      enabled: true,
    });

    const req = mockRequest("POST", "/api/auth/change-password", {
      actor: { type: "board", userId: "user-1", source: "session" },
      headers: { "x-forwarded-for": "74.120.168.78", "user-agent": "curl/8.18.0" },
    });
    const res = mockRes();
    await runWrapper(wrapped, req, res);

    expect(inner).toHaveBeenCalledTimes(1);
    // Wait one microtask for the voided async audit persist to settle.
    await microtaskTick();

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertArg = insertChain.values.mock.calls[0][0];
    expect(insertArg).toMatchObject({
      action: "/api/auth/change-password",
      method: "POST",
      statusCode: 200,
      success: true,
      actorType: "board",
      actorUserId: "user-1",
      actorSource: "session",
      targetUserId: "user-1",
      ipAddress: "74.120.168.78",
      userAgent: "curl/8.18.0",
      accountId: null,
      errorMessage: null,
    });
    expect(typeof insertArg.id).toBe("string");
    expect(insertArg.id.length).toBeGreaterThan(0);
    expect(insertArg.occurredAt instanceof Date).toBe(true);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set.mock.calls[0][0]).toMatchObject({
      lastPasswordChangedByUserId: "user-1",
      lastPasswordChangedByAgentId: null,
      lastPasswordChangeSource: "session",
    });
  });

  it("records a failed write without stamping account", async () => {
    const inner = vi.fn().mockImplementation((_req, res) => {
      res.statusCode = 400;
      return Promise.resolve();
    });
    const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
    const updateChain = { set: vi.fn().mockReturnValue({ where: vi.fn() }) };
    const db = {
      insert: vi.fn().mockReturnValue(insertChain),
      update: vi.fn().mockReturnValue(updateChain),
    };
    const wrapped = wrapBetterAuthHandlerWithPasswordAudit(inner as any, {
      db: db as any,
      enabled: true,
    });

    const req = mockRequest("POST", "/api/auth/change-password", {
      actor: { type: "board", userId: "user-2", source: "session" },
    });
    const res = mockRes(400);
    await runWrapper(wrapped, req, res);
    await microtaskTick();

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertChain.values.mock.calls[0][0]).toMatchObject({
      statusCode: 400,
      success: false,
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("records but does not throw when DB insert fails", async () => {
    const inner = vi.fn().mockImplementation((_req, res) => {
      res.statusCode = 200;
      return Promise.resolve();
    });
    const insertChain = {
      values: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const db = { insert: vi.fn().mockReturnValue(insertChain), update: vi.fn() };
    const wrapped = wrapBetterAuthHandlerWithPasswordAudit(inner as any, {
      db: db as any,
      enabled: true,
    });

    const req = mockRequest("POST", "/api/auth/change-password", {
      actor: { type: "board", userId: "user-3", source: "session" },
    });
    const res = mockRes();
    await expect(runWrapper(wrapped, req, res)).resolves.toBeUndefined();
    await microtaskTick();
    // Wrapper must not propagate the audit-row failure to the response.
    expect(res.statusCode).toBe(200);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("passes the handler error to next() and still records the audit", async () => {
    const inner = vi.fn().mockRejectedValue(new Error("handler boom"));
    const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
    const db = {
      insert: vi.fn().mockReturnValue(insertChain),
      update: vi.fn().mockReturnValue({ set: vi.fn() }),
    };
    const wrapped = wrapBetterAuthHandlerWithPasswordAudit(inner as any, {
      db: db as any,
      enabled: true,
    });
    const next = vi.fn();

    const req = mockRequest("POST", "/api/auth/change-password", {
      actor: { type: "board", userId: "user-4", source: "session" },
    });
    const res = mockRes(500);

    await expect(
      (wrapped as any)(req, res, next),
    ).resolves.toBeUndefined();
    await microtaskTick();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("disabled wrapper behaves like the raw handler (no audit, no DB calls)", async () => {
    const inner = vi.fn().mockImplementation((_req, res) => {
      res.statusCode = 200;
      return Promise.resolve();
    });
    const db = { insert: vi.fn(), update: vi.fn() };
    const wrapped = wrapBetterAuthHandlerWithPasswordAudit(inner as any, {
      db: db as any,
      enabled: false,
    });

    const req = mockRequest("POST", "/api/auth/change-password");
    const res = mockRes();
    await runWrapper(wrapped, req, res);
    await microtaskTick();

    expect(inner).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("handles requests where actor is missing entirely (defensive)", async () => {
    const inner = vi.fn().mockImplementation((_req, res) => {
      res.statusCode = 200;
      return Promise.resolve();
    });
    const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
    const db = {
      insert: vi.fn().mockReturnValue(insertChain),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) }),
    };
    const wrapped = wrapBetterAuthHandlerWithPasswordAudit(inner as any, {
      db: db as any,
      enabled: true,
    });

    const req = mockRequest("POST", "/api/auth/reset-password", {
      actor: undefined as unknown as Request["actor"],
    });
    const res = mockRes();
    await runWrapper(wrapped, req, res);
    await microtaskTick();

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertArg = insertChain.values.mock.calls[0][0];
    expect(insertArg).toMatchObject({
      actorType: "none",
      actorUserId: null,
      targetUserId: null,
      success: true,
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});

function runWrapper(wrapped: any, req: Request, res: Response): Promise<void> {
  const next: NextFunction = (err?: any) => {
    if (err) throw err;
  };
  return Promise.resolve(wrapped(req, res, next));
}

async function microtaskTick(): Promise<void> {
  // Two microtasks: one for the voided emitAudit call to start,
  // one for its internal await chain to settle.
  await Promise.resolve();
  await Promise.resolve();
}
