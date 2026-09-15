import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  issueWorkspaceLoginHandoff,
  resolveWorkspaceHandoffBoardIdentity,
  workspaceLoginHandoffFailureStatus,
} from "../services/workspace-login-handoff-issuer.js";
import { verifyWorkspaceHandoffTicket } from "../auth/workspace-login-handoff.js";
import { resolveManagedWorkspaceIdentity } from "../services/managed-workspace-identity.js";
import { WORKSPACE_HANDOFF_TICKET_QUERY_PARAM } from "../auth/workspace-login-handoff.js";

const INSTANCE_ID = "pap-17572-live-workspace-aa11bb22cc33";
const EXECUTION_WORKSPACE_ID = "ews-live-1";
const COMPANY_ID = "company-1";
const RUNTIME_URL = "https://workspace.example.ts.net:42013/";

const tempDirs: string[] = [];
let previousSecret: string | undefined;

function createWorkspaceCwd(instanceId: string | null) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paperclip-handoff-issuer-"));
  tempDirs.push(cwd);
  mkdirSync(path.join(cwd, ".paperclip"), { recursive: true });
  if (instanceId) {
    writeFileSync(
      path.join(cwd, ".paperclip", ".env"),
      `PAPERCLIP_HOME=/srv/home\nPAPERCLIP_INSTANCE_ID=${instanceId}\n`,
      "utf8",
    );
  }
  return cwd;
}

/**
 * Minimal drizzle-shaped stub. `select({ id, url, updatedAt })` is the live
 * runtime lookup; anything else is the instance-admin lookup.
 */
function stubDb(input: {
  runtimeRows?: Array<{ id: string; url: string | null; updatedAt: Date }>;
  adminRows?: Array<{ id: string; email: string | null; createdAt: Date }>;
}) {
  return {
    select: vi.fn((projection: Record<string, unknown>) => {
      const rows = "url" in projection ? input.runtimeRows ?? [] : input.adminRows ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "innerJoin", "orderBy", "limit"]) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return chain;
    }),
  } as unknown as Db;
}

function readyProbe() {
  return vi.fn(async () => ({
    ok: true as const,
    readiness: {
      state: "ready" as const,
      databaseReady: true,
      cloneDataReady: true,
      authHandoffReady: true,
      authHandoffUserId: "user-1",
      seedState: "verified" as const,
      seedPhase: "complete",
      seedMode: "minimal" as const,
      instanceId: INSTANCE_ID,
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
      companyId: COMPANY_ID,
      failurePhase: null,
    },
  }));
}

beforeEach(() => {
  previousSecret = process.env.PAPERCLIP_WORKSPACE_HANDOFF_SECRET;
  process.env.PAPERCLIP_WORKSPACE_HANDOFF_SECRET = "issuer-test-root-secret";
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env.PAPERCLIP_WORKSPACE_HANDOFF_SECRET;
  else process.env.PAPERCLIP_WORKSPACE_HANDOFF_SECRET = previousSecret;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("issueWorkspaceLoginHandoff", () => {
  it("mints a ticket the target workspace accepts, bound to the live runtime origin", async () => {
    const cwd = createWorkspaceCwd(INSTANCE_ID);
    const probe = readyProbe();
    const result = await issueWorkspaceLoginHandoff({
      db: stubDb({ runtimeRows: [{ id: "runtime-1", url: RUNTIME_URL, updatedAt: new Date() }] }),
      companyId: COMPANY_ID,
      executionWorkspace: { id: EXECUTION_WORKSPACE_ID, cwd },
      actor: { userId: "user-1", userEmail: "operator@example.com", source: "session" },
      next: "/PAP/issues/PAP-17572",
      probe,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.issuance.url);
    expect(url.origin).toBe("https://workspace.example.ts.net:42013");
    expect(url.pathname).toBe("/api/auth/workspace-handoff/exchange");

    // The guest independently derives the same key, so the round trip proves the
    // control plane and the workspace agree without sharing a stored token.
    const identity = resolveManagedWorkspaceIdentity({
      workspaceCwd: cwd,
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
      companyId: COMPANY_ID,
    });
    const verification = verifyWorkspaceHandoffTicket({
      ticket: url.searchParams.get(WORKSPACE_HANDOFF_TICKET_QUERY_PARAM),
      key: identity!.handoffKey,
      expected: {
        instanceId: INSTANCE_ID,
        executionWorkspaceId: EXECUTION_WORKSPACE_ID,
        companyId: COMPANY_ID,
        origin: "https://workspace.example.ts.net:42013",
      },
    });
    expect(verification.ok).toBe(true);
    expect(verification.ok && verification.payload).toMatchObject({
      sub: "user-1",
      email: "operator@example.com",
      next: "/PAP/issues/PAP-17572",
    });
    // Readiness is probed against the origin the user will be sent to, not a
    // separately configured address.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0]!.healthUrl).toBe("https://workspace.example.ts.net:42013/api/health");
    expect(probe.mock.calls[0]![0]!.handoffSubject).toEqual({
      userId: "user-1",
      email: "operator@example.com",
    });
  });

  it("refuses to mint a ticket for a workspace that is not ready", async () => {
    const cwd = createWorkspaceCwd(INSTANCE_ID);
    const result = await issueWorkspaceLoginHandoff({
      db: stubDb({ runtimeRows: [{ id: "runtime-1", url: RUNTIME_URL, updatedAt: new Date() }] }),
      companyId: COMPANY_ID,
      executionWorkspace: { id: EXECUTION_WORKSPACE_ID, cwd },
      actor: { userId: "user-1", userEmail: "operator@example.com", source: "session" },
      probe: vi.fn(async () => ({
        ok: false as const,
        reason: "not_ready" as const,
        readiness: null,
        detail: "clone_data_missing",
      })),
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "workspace_not_ready", detail: "clone_data_missing" },
    });
  });

  it("refuses when no healthy runtime row publishes a URL", async () => {
    const cwd = createWorkspaceCwd(INSTANCE_ID);
    const result = await issueWorkspaceLoginHandoff({
      db: stubDb({ runtimeRows: [] }),
      companyId: COMPANY_ID,
      executionWorkspace: { id: EXECUTION_WORKSPACE_ID, cwd },
      actor: { userId: "user-1", userEmail: "operator@example.com", source: "session" },
      probe: readyProbe(),
    });
    expect(result).toMatchObject({ ok: false, failure: { reason: "runtime_not_running" } });
  });

  it("refuses a runtime row whose URL is not an absolute http(s) origin", async () => {
    const cwd = createWorkspaceCwd(INSTANCE_ID);
    const result = await issueWorkspaceLoginHandoff({
      db: stubDb({ runtimeRows: [{ id: "runtime-1", url: "not-a-url", updatedAt: new Date() }] }),
      companyId: COMPANY_ID,
      executionWorkspace: { id: EXECUTION_WORKSPACE_ID, cwd },
      actor: { userId: "user-1", userEmail: "operator@example.com", source: "session" },
      probe: readyProbe(),
    });
    expect(result).toMatchObject({ ok: false, failure: { reason: "runtime_url_unusable" } });
  });

  it("fails closed when the worktree instance identity cannot be resolved", async () => {
    const result = await issueWorkspaceLoginHandoff({
      db: stubDb({ runtimeRows: [{ id: "runtime-1", url: RUNTIME_URL, updatedAt: new Date() }] }),
      companyId: COMPANY_ID,
      executionWorkspace: { id: EXECUTION_WORKSPACE_ID, cwd: null },
      actor: { userId: "user-1", userEmail: "operator@example.com", source: "session" },
      probe: readyProbe(),
    });
    expect(result).toMatchObject({ ok: false, failure: { reason: "handoff_not_configured" } });
  });

  it("falls back to credentials when no signing secret is configured at all", async () => {
    delete process.env.PAPERCLIP_WORKSPACE_HANDOFF_SECRET;
    const previousAuthSecret = process.env.BETTER_AUTH_SECRET;
    const previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    try {
      const cwd = createWorkspaceCwd(INSTANCE_ID);
      const result = await issueWorkspaceLoginHandoff({
        db: stubDb({ runtimeRows: [{ id: "runtime-1", url: RUNTIME_URL, updatedAt: new Date() }] }),
        companyId: COMPANY_ID,
        executionWorkspace: { id: EXECUTION_WORKSPACE_ID, cwd },
        actor: { userId: "user-1", userEmail: "operator@example.com", source: "session" },
        probe: readyProbe(),
      });
      expect(result).toMatchObject({ ok: false, failure: { reason: "handoff_not_configured" } });
    } finally {
      if (previousAuthSecret !== undefined) process.env.BETTER_AUTH_SECRET = previousAuthSecret;
      if (previousJwtSecret !== undefined) process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
    }
  });

  it("refuses an actor with no resolvable board identity", async () => {
    const cwd = createWorkspaceCwd(INSTANCE_ID);
    const result = await issueWorkspaceLoginHandoff({
      db: stubDb({ adminRows: [] }),
      companyId: COMPANY_ID,
      executionWorkspace: { id: EXECUTION_WORKSPACE_ID, cwd },
      actor: { userId: null, userEmail: null, source: "session" },
      probe: readyProbe(),
    });
    expect(result).toMatchObject({ ok: false, failure: { reason: "no_board_identity" } });
  });

  it("normalizes a landing target that tries to leave the workspace origin", async () => {
    const cwd = createWorkspaceCwd(INSTANCE_ID);
    const result = await issueWorkspaceLoginHandoff({
      db: stubDb({ runtimeRows: [{ id: "runtime-1", url: RUNTIME_URL, updatedAt: new Date() }] }),
      companyId: COMPANY_ID,
      executionWorkspace: { id: EXECUTION_WORKSPACE_ID, cwd },
      actor: { userId: "user-1", userEmail: "operator@example.com", source: "session" },
      next: "https://attacker.example.com/steal",
      probe: readyProbe(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const identity = resolveManagedWorkspaceIdentity({
      workspaceCwd: cwd,
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
      companyId: COMPANY_ID,
    });
    const verification = verifyWorkspaceHandoffTicket({
      ticket: new URL(result.issuance.url).searchParams.get(WORKSPACE_HANDOFF_TICKET_QUERY_PARAM),
      key: identity!.handoffKey,
      expected: {
        instanceId: INSTANCE_ID,
        executionWorkspaceId: EXECUTION_WORKSPACE_ID,
        companyId: COMPANY_ID,
        origin: "https://workspace.example.ts.net:42013",
      },
    });
    expect(verification.ok && verification.payload.next).toBe("/");
  });
});

describe("resolveWorkspaceHandoffBoardIdentity", () => {
  it("uses the caller's own session identity", async () => {
    await expect(
      resolveWorkspaceHandoffBoardIdentity(stubDb({}), {
        userId: "user-9",
        userEmail: "nine@example.com",
        source: "session",
      }),
    ).resolves.toEqual({ userId: "user-9", email: "nine@example.com" });
  });

  it("stands in the instance admin for the implicit local-trusted actor", async () => {
    await expect(
      resolveWorkspaceHandoffBoardIdentity(
        stubDb({ adminRows: [{ id: "admin-1", email: "admin@example.com", createdAt: new Date(0) }] }),
        { userId: "local-board", userEmail: null, source: "local_implicit" },
      ),
    ).resolves.toEqual({ userId: "admin-1", email: "admin@example.com" });
  });

  it("returns null when a local-trusted instance has no instance admin", async () => {
    await expect(
      resolveWorkspaceHandoffBoardIdentity(stubDb({ adminRows: [] }), {
        userId: "local-board",
        userEmail: null,
        source: "local_implicit",
      }),
    ).resolves.toBeNull();
  });
});

describe("workspaceLoginHandoffFailureStatus", () => {
  it("separates authorization, unsupported, and conflict outcomes", () => {
    expect(workspaceLoginHandoffFailureStatus({ reason: "no_board_identity" })).toBe(403);
    expect(workspaceLoginHandoffFailureStatus({ reason: "handoff_not_configured" })).toBe(501);
    expect(workspaceLoginHandoffFailureStatus({ reason: "runtime_not_running" })).toBe(409);
    expect(
      workspaceLoginHandoffFailureStatus({ reason: "workspace_not_ready", detail: null, readiness: null }),
    ).toBe(409);
  });
});
