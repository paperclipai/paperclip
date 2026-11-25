/**
 * HTTP-level coverage for the Better Auth exchange endpoint (PAP-17572).
 *
 * The security matrix itself lives in `workspace-login-handoff.test.ts`, which
 * exercises the pure verifier and the dependency-injected exchange. This suite
 * proves the wiring a browser actually meets: the plugin is registered on the
 * Better Auth mount, a valid ticket answers with a redirect and a session cookie,
 * a rejected ticket redirects to the labeled credential fallback without one, and
 * the exchange never trusts a forwarded host header.
 */

import express from "express";
import request from "supertest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  deriveWorkspaceHandoffKey,
  issueWorkspaceHandoffTicket,
  WORKSPACE_HANDOFF_TICKET_QUERY_PARAM,
} from "../auth/workspace-login-handoff.js";
import { workspaceLoginHandoffPlugin } from "../auth/workspace-login-handoff-plugin.js";

const ROOT_SECRET = "endpoint-test-root-secret";
const INSTANCE_ID = "pap-17572-endpoint-1122334455";
const EXECUTION_WORKSPACE_ID = "ews-endpoint-1";
const COMPANY_ID = "company-endpoint-1";
const ORIGIN = "http://workspace.localhost:42013";
const USER_ID = "cloned-user-1";
const USER_EMAIL = "operator@example.com";

const KEY = deriveWorkspaceHandoffKey({
  rootSecret: ROOT_SECRET,
  instanceId: INSTANCE_ID,
  executionWorkspaceId: EXECUTION_WORKSPACE_ID,
});

type MemoryStore = Record<string, Record<string, unknown>[]>;

/**
 * Membership lookup goes through the app `db`, not the Better Auth adapter, and
 * asks for existence — so the stub answers with rows, not a count.
 */
function stubDb(activeMembershipCount: number) {
  const rows = Array.from({ length: Math.max(0, activeMembershipCount) }, (_, index) => ({
    id: `membership-${index}`,
  }));
  return {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "innerJoin", "limit", "orderBy"]) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return chain;
    }),
  } as unknown as Db;
}

function createApp(input: {
  activeMembershipCount?: number;
  expectedOrigin?: string | null;
  expectedInstanceId?: string | null;
  expectedExecutionWorkspaceId?: string | null;
  expectedCompanyId?: string | null;
  key?: string | null;
}) {
  const store: MemoryStore = { user: [], session: [], account: [], verification: [] };
  store.user!.push({
    id: USER_ID,
    email: USER_EMAIL,
    name: "Operator",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const auth = betterAuth({
    secret: "better-auth-secret-for-endpoint-tests",
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true },
    advanced: { useSecureCookies: false },
    plugins: [
      workspaceLoginHandoffPlugin({
        db: stubDb(input.activeMembershipCount ?? 1),
        resolveExpectedIdentity: () => ({
          key: input.key === undefined ? KEY : input.key,
          instanceId: input.expectedInstanceId === undefined ? INSTANCE_ID : input.expectedInstanceId,
          executionWorkspaceId:
            input.expectedExecutionWorkspaceId === undefined
              ? EXECUTION_WORKSPACE_ID
              : input.expectedExecutionWorkspaceId,
          companyId: input.expectedCompanyId === undefined ? COMPANY_ID : input.expectedCompanyId,
          origin: input.expectedOrigin === undefined ? ORIGIN : input.expectedOrigin,
        }),
      }),
    ],
  });

  const app = express();
  app.all("/api/auth/*splat", (req, res, next) => {
    void Promise.resolve(toNodeHandler(auth)(req, res)).catch(next);
  });
  return { app, store };
}

function mintTicket(overrides: Partial<Parameters<typeof issueWorkspaceHandoffTicket>[0]> = {}) {
  return issueWorkspaceHandoffTicket({
    key: KEY,
    userId: USER_ID,
    email: USER_EMAIL,
    executionWorkspaceId: EXECUTION_WORKSPACE_ID,
    companyId: COMPANY_ID,
    instanceId: INSTANCE_ID,
    origin: ORIGIN,
    issuerInstanceId: "primary",
    ...overrides,
  }).ticket;
}

function exchange(app: express.Express, ticket: string | null) {
  const path = `/api/auth/workspace-handoff/exchange${
    ticket === null ? "" : `?${WORKSPACE_HANDOFF_TICKET_QUERY_PARAM}=${encodeURIComponent(ticket)}`
  }`;
  return request(app).get(path);
}

function sessionCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((cookie) => cookie.includes("session_token"));
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/auth/workspace-handoff/exchange", () => {
  it("redirects to the requested board path and sets exactly one session cookie", async () => {
    const { app, store } = createApp({});
    const response = await exchange(app, mintTicket({ next: "/PAP/issues/PAP-17572" }));

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${ORIGIN}/PAP/issues/PAP-17572`);
    // The ticket must not survive into the landing URL, the cache, or the referrer.
    expect(response.headers.location).not.toContain(WORKSPACE_HANDOFF_TICKET_QUERY_PARAM);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(sessionCookies(response)).toHaveLength(1);
    expect(store.session).toHaveLength(1);
    expect(store.session![0]!.userId).toBe(USER_ID);
  });

  it("does not create a second session for a replayed ticket", async () => {
    const { app, store } = createApp({});
    const ticket = mintTicket();
    expect((await exchange(app, ticket)).status).toBe(302);

    const replay = await exchange(app, ticket);
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toContain("workspaceHandoffError=replayed");
    expect(sessionCookies(replay)).toHaveLength(0);
    expect(store.session).toHaveLength(1);
  });

  it("sends a rejected ticket to the labeled credential fallback with no session", async () => {
    const { app, store } = createApp({});
    const expired = mintTicket({ now: new Date(Date.now() - 10 * 60_000), ttlSeconds: 30 });
    const response = await exchange(app, expired);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("workspaceHandoffError")).toBe("expired");
    expect(sessionCookies(response)).toHaveLength(0);
    expect(store.session).toHaveLength(0);
  });

  it("rejects a ticket for a cloned user with no active membership", async () => {
    const { app, store } = createApp({ activeMembershipCount: 0 });
    const response = await exchange(app, mintTicket());
    expect(response.headers.location).toContain("workspaceHandoffError=missing_membership");
    expect(store.session).toHaveLength(0);
  });

  it("rejects a ticket naming a user that did not survive the clone", async () => {
    const { app, store } = createApp({});
    const response = await exchange(app, mintTicket({ userId: "user-that-was-not-cloned" }));
    expect(response.headers.location).toContain("workspaceHandoffError=unknown_user");
    expect(store.session).toHaveLength(0);
  });

  it("ignores forwarded host and proto headers when checking the audience", async () => {
    const { app, store } = createApp({});
    // A ticket minted for the attacker's host must fail even when the request
    // arrives claiming to be that host.
    const spoofedTicket = mintTicket({ origin: "https://attacker.example.com" });
    const response = await exchange(app, spoofedTicket)
      .set("host", "attacker.example.com")
      .set("x-forwarded-host", "attacker.example.com")
      .set("x-forwarded-proto", "https")
      .set("x-forwarded-for", "203.0.113.7");

    expect(response.headers.location).toContain("workspaceHandoffError=origin_mismatch");
    expect(sessionCookies(response)).toHaveLength(0);
    expect(store.session).toHaveLength(0);
  });

  it("rejects a ticket bound to another workspace, instance, or company on this host", async () => {
    const { app } = createApp({});
    const otherWorkspace = await exchange(app, mintTicket({ executionWorkspaceId: "ews-sibling" }));
    expect(otherWorkspace.headers.location).toContain("workspaceHandoffError=workspace_mismatch");

    const otherInstance = await exchange(app, mintTicket({ instanceId: "another-instance" }));
    expect(otherInstance.headers.location).toContain("workspaceHandoffError=instance_mismatch");

    const otherCompany = await exchange(app, mintTicket({ companyId: "company-sibling" }));
    expect(otherCompany.headers.location).toContain("workspaceHandoffError=company_mismatch");
  });

  it("rejects a missing or garbage ticket", async () => {
    const { app } = createApp({});
    expect((await exchange(app, null)).headers.location).toContain("workspaceHandoffError=malformed");
    expect((await exchange(app, "wh1.aaaa.bbbb")).headers.location).toContain(
      "workspaceHandoffError=bad_signature",
    );
  });

  it("answers 503 rather than a redirect when the guest has no verification key", async () => {
    const { app } = createApp({ key: null });
    const response = await exchange(app, mintTicket());
    expect(response.status).toBe(503);
    expect(sessionCookies(response)).toHaveLength(0);
  });

  it("fails closed when the guest cannot resolve its own origin", async () => {
    const { app, store } = createApp({ expectedOrigin: null });
    const response = await exchange(app, mintTicket());
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("workspaceHandoffError=origin_mismatch");
    expect(store.session).toHaveLength(0);
  });
});
