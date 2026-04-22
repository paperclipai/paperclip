import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminOverrideJwt } from "../admin-override-jwt.js";
import { enforceStatusTransition } from "../middleware/status-transition.js";

const JWT_KEY = "test-key-unit-middleware";

function makeRequest(overrides: Partial<Request> & Record<string, unknown> = {}): Request {
  const req: Record<string, unknown> = {
    method: "PATCH",
    params: { id: "issue-123" },
    body: {},
    headers: {},
    get: vi.fn(function (this: Record<string, unknown>, header: string) {
      const headers = (this.headers ?? {}) as Record<string, string | undefined>;
      return headers[header.toLowerCase()];
    }),
    header: vi.fn(function (this: Record<string, unknown>, header: string) {
      const headers = (this.headers ?? {}) as Record<string, string | undefined>;
      return headers[header.toLowerCase()];
    }),
    ...overrides,
  };
  return req as unknown as Request;
}

function makeResponse() {
  const state = {
    status: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const res = {
    status: vi.fn(function (this: Response, code: number) {
      state.status = code;
      return this;
    }),
    json: vi.fn(function (this: Response, payload: unknown) {
      state.body = payload;
      return this;
    }),
    setHeader: vi.fn((name: string, value: string) => {
      state.headers[name] = value;
    }),
  } as unknown as Response;
  return { res, state };
}

function makeNext() {
  return vi.fn() as unknown as NextFunction;
}

const getIssueStatus = vi.fn(async (id: string) =>
  id === "issue-missing" ? null : { status: "in_progress" },
);

describe("enforceStatusTransition middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_STATUS_GUARD_V2;
    process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY = JWT_KEY;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_STATUS_GUARD_V2;
    delete process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY;
  });

  it("is a passthrough when PAPERCLIP_STATUS_GUARD_V2 is unset (dormant default)", async () => {
    const mw = enforceStatusTransition({ getIssueStatus });
    const req = makeRequest({ body: { status: "done" } });
    const { res, state } = makeResponse();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBe(0);
    expect(getIssueStatus).not.toHaveBeenCalled();
  });

  it("is a passthrough for non-PATCH methods even when flag is on", async () => {
    process.env.PAPERCLIP_STATUS_GUARD_V2 = "true";
    const mw = enforceStatusTransition({ getIssueStatus });
    const req = makeRequest({ method: "GET", body: { status: "done" } });
    const { res, state } = makeResponse();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBe(0);
  });

  it("is a passthrough when body does not touch governed fields", async () => {
    process.env.PAPERCLIP_STATUS_GUARD_V2 = "true";
    const mw = enforceStatusTransition({ getIssueStatus });
    const req = makeRequest({ body: { title: "new title", priority: "high" } });
    const { res, state } = makeResponse();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBe(0);
  });

  describe("with PAPERCLIP_STATUS_GUARD_V2=true", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_STATUS_GUARD_V2 = "true";
      getIssueStatus.mockClear();
    });

    it("Exception A: allows backlog <-> todo transitions", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "backlog" });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({ body: { status: "todo" } });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(state.status).toBe(0);
    });

    it("Exception B: allows * -> blocked when blockReason is present", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "in_progress" });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({
        body: { status: "blocked", blockReason: "CI is down" },
      });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(state.status).toBe(0);
    });

    it("Exception C: allows blocked -> * when unblockReason is present", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "blocked" });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({
        body: { status: "in_progress", unblockReason: "CI back up" },
      });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(state.status).toBe(0);
    });

    it("Exception D: fails closed with 503 when X-PE-Transition-Id is presented (consume path not wired)", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "in_progress" });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({
        headers: { "x-pe-transition-id": "a1b2c3d4-0000-0000-0000-000000000000" },
        body: { status: "done" },
      });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(state.status).toBe(503);
      expect((state.body as Record<string, unknown>).error).toBe("pe_artifact_verification_unavailable");
      expect(state.headers["Cache-Control"]).toBe("no-store");
    });

    it("Exception E: rejects boolean X-Admin-Override: true with 422 admin_override_boolean_form_retired", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "in_progress" });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({
        headers: { "x-admin-override": "true" },
        body: { status: "done" },
      });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(state.status).toBe(422);
      expect((state.body as Record<string, unknown>).error).toBe(
        "admin_override_boolean_form_retired",
      );
    });

    it("Exception E: accepts a well-formed CEO JWT and attaches statusGuard context", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "in_progress" });
      const token = createAdminOverrideJwt({
        subject: "ceo-user",
        issueId: "issue-123",
        oldStatus: "in_progress",
        newStatus: "done",
        reason: "ceo-breakglass-approved-2026-04-22",
        jti: "jti-1",
        ttlSeconds: 60,
      });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({
        headers: { "x-admin-override": token ?? "" },
        body: { status: "done" },
      });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(state.status).toBe(0);
      const statusGuard = (req as Request & {
        statusGuard?: { adminOverride?: { jti: string; principalUserId: string } };
      }).statusGuard;
      expect(statusGuard?.adminOverride?.jti).toBe("jti-1");
      expect(statusGuard?.adminOverride?.principalUserId).toBe("ceo-user");
    });

    it("Exception E: rejects a JWT that does not bind exactly to the requested transition", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "in_progress" });
      const token = createAdminOverrideJwt({
        subject: "ceo-user",
        issueId: "issue-123",
        oldStatus: "in_progress",
        newStatus: "done",
        reason: "ceo-breakglass-approved-2026-04-22",
        jti: "jti-2",
        ttlSeconds: 60,
      });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({
        headers: { "x-admin-override": token ?? "" },
        body: { status: "cancelled" }, // JWT bound to done, request says cancelled
      });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(state.status).toBe(422);
      expect((state.body as Record<string, unknown>).error).toBe(
        "admin_override_bounds_mismatch",
      );
    });

    it("denies with 422 status_transition_blocked when no exception matches", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "in_progress" });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({ body: { status: "done" } });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(state.status).toBe(422);
      const body = state.body as Record<string, unknown>;
      expect(body.error).toBe("status_transition_blocked");
      expect(Array.isArray(body.legalPaths)).toBe(true);
      expect(typeof body.request_id).toBe("string");
    });

    it("echoes X-Request-Id when well-formed, otherwise generates a UUID", async () => {
      getIssueStatus.mockResolvedValueOnce({ status: "in_progress" });
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({
        headers: { "x-request-id": "incident-42" },
        body: { status: "done" },
      });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(state.status).toBe(422);
      expect((state.body as Record<string, unknown>).request_id).toBe("incident-42");
    });

    it("is a passthrough when the issue is not found (leaves 404 to downstream handler)", async () => {
      const mw = enforceStatusTransition({ getIssueStatus });
      const req = makeRequest({ params: { id: "issue-missing" }, body: { status: "done" } });
      const { res, state } = makeResponse();
      const next = makeNext();

      await mw(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(state.status).toBe(0);
    });
  });
});
