import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { jadeGateGuard } from "../middleware/jade-gate.js";

type ReqInput = {
  path?: string;
  remoteAddress?: string | undefined;
  headers?: Record<string, string>;
};

function fakeRequest(input: ReqInput): Request {
  const headers = input.headers ?? {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    path: input.path ?? "/api/anything",
    socket: { remoteAddress: input.remoteAddress } as Request["socket"],
    headers: lower,
    header(name: string) {
      return lower[name.toLowerCase()];
    },
  } as unknown as Request;
}

function fakeResponse() {
  const res: Partial<Response> & { _status?: number; _body?: string } = {};
  res.status = function (code: number) {
    this._status = code;
    return this as Response;
  } as Response["status"];
  res.type = function () {
    return this as Response;
  } as Response["type"];
  res.send = function (body: string) {
    this._body = body;
    return this as Response;
  } as Response["send"];
  return res as Response & { _status?: number; _body?: string };
}

describe("jadeGateGuard", () => {
  const originalSecret = process.env.JADE_GATE_SECRET;

  beforeEach(() => {
    process.env.JADE_GATE_SECRET = "test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JADE_GATE_SECRET;
    else process.env.JADE_GATE_SECRET = originalSecret;
  });

  it("rejects requests missing the gate header", () => {
    const res = fakeResponse();
    let nextCalled = false;
    jadeGateGuard()(fakeRequest({ remoteAddress: "10.0.0.5" }), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(403);
    expect(res._body).toBe("gate_required");
  });

  it("accepts requests with the matching gate header", () => {
    let nextCalled = false;
    jadeGateGuard()(
      fakeRequest({
        remoteAddress: "10.0.0.5",
        headers: { "x-jade-gate-secret": "test-secret" },
      }),
      fakeResponse(),
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it("bypasses the gate for loopback peers (IPv4)", () => {
    let nextCalled = false;
    jadeGateGuard()(fakeRequest({ remoteAddress: "127.0.0.1" }), fakeResponse(), () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("bypasses the gate for loopback peers (IPv6 and v4-mapped)", () => {
    for (const peer of ["::1", "::ffff:127.0.0.1"]) {
      let nextCalled = false;
      jadeGateGuard()(fakeRequest({ remoteAddress: peer }), fakeResponse(), () => {
        nextCalled = true;
      });
      expect(nextCalled, `peer=${peer}`).toBe(true);
    }
  });

  it("refuses loopback bypass when forwarding headers are present", () => {
    for (const name of ["x-forwarded-for", "x-forwarded-host", "fly-client-ip", "forwarded"]) {
      const res = fakeResponse();
      let nextCalled = false;
      jadeGateGuard()(
        fakeRequest({
          remoteAddress: "127.0.0.1",
          headers: { [name]: "1.2.3.4" },
        }),
        res,
        () => {
          nextCalled = true;
        },
      );
      expect(nextCalled, `header=${name}`).toBe(false);
      expect(res._status, `header=${name}`).toBe(403);
    }
  });

  it("is a no-op when JADE_GATE_SECRET is unset", () => {
    delete process.env.JADE_GATE_SECRET;
    let nextCalled = false;
    jadeGateGuard()(fakeRequest({ remoteAddress: "10.0.0.5" }), fakeResponse(), () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("exempts /api/health regardless of peer or header", () => {
    let nextCalled = false;
    jadeGateGuard()(
      fakeRequest({ path: "/api/health", remoteAddress: "10.0.0.5" }),
      fakeResponse(),
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it("accepts /api/* requests bearing an Authorization: Bearer header", () => {
    let nextCalled = false;
    jadeGateGuard()(
      fakeRequest({
        path: "/api/issues/MYC-4",
        remoteAddress: "10.0.0.5",
        headers: { authorization: "Bearer some-agent-key" },
      }),
      fakeResponse(),
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it("rejects /api/auth/* even with a Bearer header (no signup bypass)", () => {
    const res = fakeResponse();
    let nextCalled = false;
    jadeGateGuard()(
      fakeRequest({
        path: "/api/auth/signup",
        remoteAddress: "10.0.0.5",
        headers: { authorization: "Bearer fake" },
      }),
      res,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(403);
    expect(res._body).toBe("gate_required");
  });

  it("rejects non-/api/* requests with a Bearer header", () => {
    const res = fakeResponse();
    let nextCalled = false;
    jadeGateGuard()(
      fakeRequest({
        path: "/dashboard",
        remoteAddress: "10.0.0.5",
        headers: { authorization: "Bearer some-agent-key" },
      }),
      res,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(403);
  });

  it("rejects malformed Authorization headers (no Bearer prefix)", () => {
    const res = fakeResponse();
    let nextCalled = false;
    jadeGateGuard()(
      fakeRequest({
        path: "/api/issues",
        remoteAddress: "10.0.0.5",
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      }),
      res,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(403);
  });

  it("rejects empty Bearer tokens", () => {
    const res = fakeResponse();
    let nextCalled = false;
    jadeGateGuard()(
      fakeRequest({
        path: "/api/issues",
        remoteAddress: "10.0.0.5",
        headers: { authorization: "Bearer " },
      }),
      res,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(403);
  });
});
