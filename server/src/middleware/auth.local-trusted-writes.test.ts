import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "./auth.js";

/**
 * paperclipai/paperclip#8019, #15027.
 *
 * In `local_trusted` the actor middleware seeds the *human's* identity on every
 * request before it looks at any credential. A credential-less write therefore
 * used to succeed and land in the database as `local-board`, so a writer that
 * lost its credential never failed loudly — it forged a record in the board
 * operator's voice that came back in wakes as if they had written it.
 *
 * These tests pin the guard: writes need a resolved principal, and the browser
 * board — which in this mode holds no session and sends no Authorization header —
 * keeps working.
 */

type MiddlewareInit = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
};

function fakeRequest(init: MiddlewareInit): Request {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const path = init.path ?? "/api/issues/abc/comments";
  return {
    method: init.method ?? "GET",
    path,
    originalUrl: path,
    header: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as Request;
}

async function run(init: MiddlewareInit, deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const req = fakeRequest(init);
  // The local_trusted credential-less paths never touch `db`, and this keeps the
  // test free of an embedded Postgres boot. The bearer cases do reach the board
  // key lookup, which calls `db.select().from().where().then()`, so the stub
  // returns a query chain that resolves to no rows: an unrecognised bearer
  // resolves to no key and the existing 401 in the bearer branch is reached.
  const emptyQuery = {
    from: () => emptyQuery,
    where: () => emptyQuery,
    then: (onFulfilled: (rows: never[]) => unknown) => Promise.resolve([]).then(onFulfilled),
  };
  const handler = actorMiddleware({ select: () => emptyQuery } as unknown as Db, { deploymentMode });
  let passed = false;
  let error: unknown;
  await handler(req, {} as Response, (nextError?: unknown) => {
    if (nextError) error = nextError;
    else passed = true;
  });
  // `unauthorized()` builds an HttpError, which carries `status` and `message`.
  // Checked structurally so the test does not depend on that internal class.
  const httpError =
    error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number; message: string })
      : null;
  return {
    req,
    passed,
    error,
    status: httpError ? httpError.status : null,
    message: httpError ? httpError.message : null,
  };
}

describe("actorMiddleware — local_trusted writes require a principal", () => {
  it("refuses a credential-less comment write and writes nothing", async () => {
    const result = await run({ method: "POST", path: "/api/issues/abc/comments" });

    expect(result.status).toBe(401);
    expect(result.passed).toBe(false);
    // The handler errored, so no route ran and no row was created.
    expect(result.req.actor).toEqual(
      expect.objectContaining({ type: "board", userId: "local-board", source: "local_implicit" }),
    );
  });

  it("refuses a credential-less issue creation", async () => {
    const result = await run({ method: "POST", path: "/api/companies/company-1/issues" });

    expect(result.status).toBe(401);
    expect(result.passed).toBe(false);
  });

  it("refuses a credential-less issue patch", async () => {
    const result = await run({ method: "PATCH", path: "/api/issues/abc" });

    expect(result.status).toBe(401);
    expect(result.passed).toBe(false);
  });

  it("refuses a credential-less write that only offers a forged Referer", async () => {
    // The guard in #7763 was bypassed exactly this way. Referer must not be
    // enough to claim board identity.
    const result = await run({
      method: "POST",
      headers: { referer: "http://127.0.0.1:3100/board" },
    });

    expect(result.status).toBe(401);
  });

  it("refuses a write from a foreign Origin", async () => {
    const result = await run({
      method: "POST",
      headers: { host: "127.0.0.1:3100", origin: "https://evil.example" },
    });

    expect(result.status).toBe(401);
  });

  it("refuses an agent run that lost its credential", async () => {
    const result = await run({
      method: "POST",
      headers: { "x-paperclip-run-id": "run-abc" },
    });

    expect(result.status).toBe(401);
    expect(result.message).toContain("run-abc");
  });

  it("refuses an agent run marker even when browser headers are also present", async () => {
    // A machine inside a run must never be able to borrow the board's
    // browser identity by adding an Origin header.
    const result = await run({
      method: "POST",
      headers: {
        "x-paperclip-run-id": "run-abc",
        host: "127.0.0.1:3100",
        origin: "http://127.0.0.1:3100",
      },
    });

    expect(result.status).toBe(401);
    expect(result.message).toContain("run-abc");
  });

  it("keeps serving reads to the credential-less board", async () => {
    const result = await run({ method: "GET", path: "/api/issues/abc" });

    expect(result.passed).toBe(true);
    expect(result.req.actor).toEqual(
      expect.objectContaining({ type: "board", userId: "local-board", source: "local_implicit" }),
    );
  });

  it("keeps serving the board's own same-origin write", async () => {
    const result = await run({
      method: "POST",
      headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
    });

    expect(result.passed).toBe(true);
    expect(result.req.actor).toEqual(
      expect.objectContaining({ type: "board", userId: "local-board", source: "local_implicit" }),
    );
  });

  it("keeps serving a browser that omits Origin but sends Sec-Fetch-Site", async () => {
    // A real browser sends Sec-Fetch-Site on every fetch and omits Origin for
    // same-origin GETs and some form posts. Sec-Fetch-Site is the one
    // Sec-Fetch-* value the browser controls that a plain HTTP client does not
    // synthesise, so it is the signal the guard reads.
    const result = await run({
      method: "POST",
      headers: { host: "127.0.0.1:3100", "sec-fetch-site": "same-origin" },
    });

    expect(result.passed).toBe(true);
    expect(result.req.actor).toEqual(
      expect.objectContaining({ type: "board", userId: "local-board" }),
    );
  });

  it("refuses a bare Sec-Fetch-Mode, which Node's fetch() synthesises", async () => {
    // Node's built-in fetch() puts Sec-Fetch-Mode: cors on every credential-less
    // request, so accepting a bare Sec-Fetch-Mode would let any ordinary Node
    // script write as the board operator without forging a single header. The
    // guard reads Sec-Fetch-Site instead, which Node never sets on its own.
    const cors = await run({
      method: "POST",
      headers: { host: "127.0.0.1:3100", "sec-fetch-mode": "cors" },
    });
    expect(cors.status).toBe(401);
    expect(cors.passed).toBe(false);

    // Even a hand-set same-origin mode is not enough on its own.
    const modeOnly = await run({
      method: "POST",
      headers: { host: "127.0.0.1:3100", "sec-fetch-mode": "same-origin" },
    });
    expect(modeOnly.status).toBe(401);
    expect(modeOnly.passed).toBe(false);

    // And a cross-site browser request stays refused.
    const crossSite = await run({
      method: "POST",
      headers: { host: "127.0.0.1:3100", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(401);
  });

  it("lets the agent bootstrap routes reach their own secret checks", async () => {
    // An agent's invite acceptance and its initial key claim cannot present a
    // bearer, because neither has a key yet. Both routes verify the secret in
    // the body themselves, so the guard must hand them through rather than
    // refuse before they get there.
    const accept = await run({
      method: "POST",
      path: "/api/invites/inv_abc123/accept",
    });
    expect(accept.passed).toBe(true);
    expect(accept.req.actor).toEqual(expect.objectContaining({ type: "none" }));

    const claim = await run({
      method: "POST",
      path: "/api/join-requests/req_abc123/claim-api-key",
    });
    expect(claim.passed).toBe(true);
    expect(claim.req.actor).toEqual(expect.objectContaining({ type: "none" }));
  });

  it("does not extend the bootstrap exemption to neighbouring routes", async () => {
    // The exemption is those two routes and nothing else. Every probe here is a
    // POST, because only a mutating method reaches this guard at all -- reads
    // are served credential-less by design and are covered by their own test.
    const revoke = await run({
      method: "POST",
      path: "/api/invites/inv_abc123/revoke",
    });
    expect(revoke.status).toBe(401);
    expect(revoke.passed).toBe(false);

    // A trailing segment must not slip past the anchored pattern.
    const trailing = await run({
      method: "POST",
      path: "/api/join-requests/req_abc123/claim-api-key/extra",
    });
    expect(trailing.status).toBe(401);
    expect(trailing.passed).toBe(false);

    // Neither may the exemption reach a different invite sub-resource.
    const other = await run({
      method: "POST",
      path: "/api/invites/inv_abc123/accept/extra",
    });
    expect(other.status).toBe(401);
    expect(other.passed).toBe(false);
  });

  it("leaves the routine webhook ingress alone", async () => {
    const result = await run({
      method: "POST",
      path: "/api/routine-triggers/public/0123456789abcdef01234567/fire",
    });

    expect(result.passed).toBe(true);
  });

  it("does not shadow the existing bearer credential failures", async () => {
    // An empty and an unrecognised bearer must still fail in the bearer branch,
    // which is downstream of the new guard.
    const empty = await run({ method: "POST", headers: { authorization: "Bearer " } });
    expect(empty.status).toBe(401);
    expect(empty.message).toContain("Empty bearer token");

    const bogus = await run({ method: "POST", headers: { authorization: "Bearer not-a-real-key" } });
    expect(bogus.status).toBe(401);
  });

  it("does not change authenticated mode", async () => {
    const result = await run({ method: "POST" }, "authenticated");

    // Unchanged behaviour: no session resolved, so the actor stays unresolved
    // and the route is responsible for refusing. The new guard is local_trusted
    // only.
    expect(result.passed).toBe(true);
    expect(result.req.actor).toEqual(expect.objectContaining({ type: "none" }));
  });
});