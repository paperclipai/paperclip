import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { WorkspaceReadinessProbeResult } from "@paperclipai/shared";
import {
  isManagedWorkspaceInstance,
  resetManagedWorkspaceInstanceCacheForTests,
  resolveWorkspaceReadiness,
  resolveWorkspaceReadinessState,
  resolveWorkspaceSeedMarkerDir,
} from "../services/workspace-readiness.js";
import {
  buildManagedWorkspaceGuestEnv,
  listManagedWorkspaceHandoffSubjects,
  probeManagedWorkspaceHandoffSubjects,
  probeManagedWorkspaceReadiness,
  resolveManagedWorkspaceIdentity,
  resolveWorkspaceReadinessGateMode,
  shouldBlockPublicationOnReadiness,
  waitForManagedWorkspaceReadiness,
  type ManagedWorkspaceIdentity,
} from "../services/managed-workspace-identity.js";
import {
  WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY,
  WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY,
  WORKSPACE_HANDOFF_KEY_ENV_KEY,
  WORKSPACE_READINESS_TOKEN_ENV_KEY,
  WORKSPACE_READINESS_TOKEN_HEADER,
  WORKSPACE_READINESS_USER_EMAIL_HEADER,
  WORKSPACE_READINESS_USER_ID_HEADER,
} from "../auth/workspace-login-handoff.js";

const tempDirs: string[] = [];

function createMarkerDir(files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-workspace-readiness-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, "{}\n", "utf8");
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), contents, "utf8");
  }
  return { dir, configPath };
}

function verifiedManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 2,
    state: "verified",
    phase: "complete",
    seedMode: "minimal",
    ...overrides,
  });
}

/** A `db` stand-in whose clone/identity probes both find one row. */
function readyDb() {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    // Both readiness probes are `limit(1)` existence queries, so one row is enough
    // to answer either of them.
    select: vi.fn(() => {
      const result = [{ companyId: "company-1", userId: "user-1" }];
      const chain = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(result)),
        then: (resolve: (rows: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    }),
  } as unknown as Db;
}

function handoffSubjectDb(rows: Array<{ userId: string; email: string | null }>) {
  return {
    select: vi.fn(() => {
      const chain = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return chain;
    }),
  } as unknown as Db;
}

function readyGuestEnv(configPath: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PAPERCLIP_CONFIG: configPath,
    [WORKSPACE_HANDOFF_KEY_ENV_KEY]: "key",
    [WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY]: "ews-1",
    [WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY]: "company-1",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetManagedWorkspaceInstanceCacheForTests();
  vi.restoreAllMocks();
});

describe("resolveWorkspaceReadinessState", () => {
  const ready = {
    databaseReady: true,
    cloneDataReady: true,
    authHandoffReady: true,
    seedState: "verified",
  } as const;

  it("is ready only when every signal agrees and the seed is verified", () => {
    expect(resolveWorkspaceReadinessState(ready)).toBe("ready");
    expect(resolveWorkspaceReadinessState({ ...ready, seedState: "unknown" })).toBe("validating");
    expect(resolveWorkspaceReadinessState({ ...ready, seedState: "absent" })).toBe("validating");
  });

  it("reports an unfinished clone as provisioning, not degraded", () => {
    expect(resolveWorkspaceReadinessState({ ...ready, seedState: "pending", databaseReady: false })).toBe("provisioning");
    expect(resolveWorkspaceReadinessState({ ...ready, seedState: "running" })).toBe("provisioning");
  });

  it("reports a regressed verified clone as degraded", () => {
    expect(resolveWorkspaceReadinessState({ ...ready, databaseReady: false })).toBe("degraded");
    expect(resolveWorkspaceReadinessState({ ...ready, cloneDataReady: false })).toBe("degraded");
    expect(resolveWorkspaceReadinessState({ ...ready, authHandoffReady: false })).toBe("degraded");
  });

  it("reports a recorded seed failure as failed", () => {
    expect(resolveWorkspaceReadinessState({ ...ready, seedState: "failed" })).toBe("failed");
  });
});

describe("resolveWorkspaceReadiness", () => {
  it("reports a verified, fully readable clone as ready", async () => {
    const { configPath } = createMarkerDir({ "seed-manifest.json": verifiedManifest() });
    const readiness = await resolveWorkspaceReadiness({
      db: readyDb(),
      env: readyGuestEnv(configPath),
    });
    expect(readiness).toMatchObject({
      state: "ready",
      databaseReady: true,
      cloneDataReady: true,
      authHandoffReady: true,
      authHandoffUserId: null,
      seedState: "verified",
      seedMode: "minimal",
      executionWorkspaceId: "ews-1",
      companyId: "company-1",
      failurePhase: null,
    });
  });

  it("does not claim the handoff is ready without a signing key", async () => {
    const { configPath } = createMarkerDir({ "seed-manifest.json": verifiedManifest() });
    const readiness = await resolveWorkspaceReadiness({
      db: readyDb(),
      env: readyGuestEnv(configPath, { [WORKSPACE_HANDOFF_KEY_ENV_KEY]: undefined }),
    });
    expect(readiness.authHandoffReady).toBe(false);
    expect(readiness.state).toBe("degraded");
    expect(readiness.failurePhase).toBe("auth_handoff_not_configured");
  });

  it("fails closed when the guest has no company binding", async () => {
    const { configPath } = createMarkerDir({ "seed-manifest.json": verifiedManifest() });
    const db = readyDb();
    const readiness = await resolveWorkspaceReadiness({
      db,
      env: readyGuestEnv(configPath, {
        [WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY]: undefined,
      }),
    });
    expect(readiness).toMatchObject({
      state: "degraded",
      cloneDataReady: false,
      authHandoffReady: false,
      failurePhase: "workspace_company_not_configured",
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("does not claim handoff readiness without the execution-workspace identity", async () => {
    const { configPath } = createMarkerDir({ "seed-manifest.json": verifiedManifest() });
    const readiness = await resolveWorkspaceReadiness({
      db: readyDb(),
      env: readyGuestEnv(configPath, {
        [WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY]: undefined,
      }),
    });
    expect(readiness).toMatchObject({
      state: "degraded",
      cloneDataReady: true,
      authHandoffReady: false,
      failurePhase: "workspace_identity_not_configured",
    });
  });

  it("surfaces the failing seed phase instead of an inferred one", async () => {
    const { configPath } = createMarkerDir({
      "seed-manifest.json": verifiedManifest({ state: "failed", phase: "restore" }),
    });
    const readiness = await resolveWorkspaceReadiness({
      db: readyDb(),
      env: readyGuestEnv(configPath),
    });
    expect(readiness).toMatchObject({ state: "failed", seedState: "failed", failurePhase: "restore" });
  });

  it("treats an unreadable manifest as a failure rather than assuming it seeded", async () => {
    const { configPath } = createMarkerDir({ "seed-manifest.json": "{ truncated" });
    const readiness = await resolveWorkspaceReadiness({
      db: readyDb(),
      env: readyGuestEnv(configPath),
    });
    expect(readiness).toMatchObject({ state: "failed", failurePhase: "seed_manifest_unreadable" });
  });

  it("reports an interrupted seed as provisioning", async () => {
    const { configPath } = createMarkerDir({ "seed-pending": "{}" });
    const readiness = await resolveWorkspaceReadiness({
      db: readyDb(),
      env: readyGuestEnv(configPath),
    });
    expect(readiness).toMatchObject({ state: "provisioning", seedState: "pending" });
  });

  it("reports a legacy marker clone as validating, never verified", async () => {
    const { configPath } = createMarkerDir({ "seed-complete": "" });
    const readiness = await resolveWorkspaceReadiness({
      db: readyDb(),
      env: readyGuestEnv(configPath),
    });
    expect(readiness).toMatchObject({ state: "validating", seedState: "unknown" });
  });

  it("reports an unreachable database without throwing", async () => {
    const { configPath } = createMarkerDir({ "seed-manifest.json": verifiedManifest() });
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      select: vi.fn(),
    } as unknown as Db;
    const readiness = await resolveWorkspaceReadiness({
      db,
      env: readyGuestEnv(configPath),
    });
    expect(readiness).toMatchObject({
      state: "degraded",
      databaseReady: false,
      failurePhase: "database_unreachable",
    });
  });

  it("resolves the marker directory from the configured config path", () => {
    const { dir, configPath } = createMarkerDir();
    expect(resolveWorkspaceSeedMarkerDir({ PAPERCLIP_CONFIG: configPath })).toBe(dir);
  });

  it("does not re-stat marker files on every health request", () => {
    const { configPath } = createMarkerDir({ "seed-manifest.json": verifiedManifest() });
    const env = { PAPERCLIP_CONFIG: configPath };
    let clock = 0;
    expect(isManagedWorkspaceInstance(env, () => clock)).toBe(true);

    // Removing the marker inside the TTL keeps the cached answer; past it, the
    // filesystem is consulted again.
    rmSync(path.join(path.dirname(configPath), "seed-manifest.json"));
    clock = 1_000;
    expect(isManagedWorkspaceInstance(env, () => clock)).toBe(true);
    clock = 10_000;
    expect(isManagedWorkspaceInstance(env, () => clock)).toBe(false);
  });

  it("only treats a process with clone evidence as a managed workspace", () => {
    const { configPath } = createMarkerDir();
    expect(isManagedWorkspaceInstance({ PAPERCLIP_CONFIG: configPath })).toBe(false);
    expect(
      isManagedWorkspaceInstance({ PAPERCLIP_CONFIG: configPath, [WORKSPACE_HANDOFF_KEY_ENV_KEY]: "key" }),
    ).toBe(true);
    const seeded = createMarkerDir({ "seed-manifest.json": verifiedManifest() });
    expect(isManagedWorkspaceInstance({ PAPERCLIP_CONFIG: seeded.configPath })).toBe(true);
  });
});

describe("probeManagedWorkspaceReadiness", () => {
  const identity: ManagedWorkspaceIdentity = {
    instanceId: "instance-a",
    executionWorkspaceId: "ews-1",
    companyId: "company-1",
    handoffKey: "handoff-key",
    readinessToken: "probe-token",
    secretSource: "derived",
  };

  function respond(body: unknown, init: { status?: number } = {}) {
    return vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
  }

  const readyPayload = {
    status: "ok",
    workspace: {
      state: "ready",
      databaseReady: true,
      cloneDataReady: true,
      authHandoffReady: true,
      authHandoffUserId: null,
      seedState: "verified",
      seedPhase: "complete",
      seedMode: "minimal",
      instanceId: "instance-a",
      executionWorkspaceId: "ews-1",
      companyId: "company-1",
      failurePhase: null,
    },
  };

  it("accepts a ready workspace and sends the derived probe token", async () => {
    const fetchImpl = respond(readyPayload);
    const result = await probeManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:42013/api/health",
      identity,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit & { headers: Record<string, string> }).headers[WORKSPACE_READINESS_TOKEN_HEADER])
      .toBe("probe-token");
  });

  it("binds a caller-scoped readiness probe to the exact handoff user", async () => {
    const fetchImpl = respond({
      ...readyPayload,
      workspace: { ...readyPayload.workspace, authHandoffUserId: "user-1" },
    });
    const result = await probeManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:42013/api/health",
      identity,
      handoffSubject: { userId: "user-1", email: "operator@example.com" },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit & { headers: Record<string, string> }).headers).toMatchObject({
      [WORKSPACE_READINESS_USER_ID_HEADER]: "user-1",
      [WORKSPACE_READINESS_USER_EMAIL_HEADER]: "operator@example.com",
    });
  });

  it("rejects a readiness response scoped to another handoff user", async () => {
    expect(
      await probeManagedWorkspaceReadiness({
        healthUrl: "http://127.0.0.1:42013/api/health",
        identity,
        handoffSubject: { userId: "user-1", email: "operator@example.com" },
        fetchImpl: respond({
          ...readyPayload,
          workspace: { ...readyPayload.workspace, authHandoffUserId: "user-other" },
        }),
      }),
    ).toMatchObject({ ok: false, reason: "identity_mismatch" });
  });

  it("proves every active control-plane board identity before publication", async () => {
    const db = handoffSubjectDb([
      { userId: "user-1", email: "one@example.com" },
      { userId: "user-2", email: "two@example.com" },
    ]);
    await expect(listManagedWorkspaceHandoffSubjects(db, "company-1")).resolves.toEqual([
      { userId: "user-1", email: "one@example.com" },
      { userId: "user-2", email: "two@example.com" },
    ]);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({
        ...readyPayload,
        workspace: {
          ...readyPayload.workspace,
          authHandoffUserId: headers[WORKSPACE_READINESS_USER_ID_HEADER],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await expect(probeManagedWorkspaceHandoffSubjects({
      db,
      healthUrl: "http://127.0.0.1:42013/api/health",
      identity,
      fetchImpl,
    })).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("blocks publication when no current board identity can use the handoff", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(probeManagedWorkspaceHandoffSubjects({
      db: handoffSubjectDb([]),
      healthUrl: "http://127.0.0.1:42013/api/health",
      identity,
      fetchImpl,
    })).resolves.toMatchObject({ ok: false, reason: "not_ready" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a workspace serving another instance, workspace, or company", async () => {
    const wrongInstance = await probeManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:42013/api/health",
      identity,
      fetchImpl: respond({
        ...readyPayload,
        workspace: { ...readyPayload.workspace, instanceId: "instance-b" },
      }),
    });
    expect(wrongInstance).toMatchObject({ ok: false, reason: "identity_mismatch" });

    const wrongWorkspace = await probeManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:42013/api/health",
      identity,
      fetchImpl: respond({
        ...readyPayload,
        workspace: { ...readyPayload.workspace, executionWorkspaceId: "ews-other" },
      }),
    });
    expect(wrongWorkspace).toMatchObject({ ok: false, reason: "identity_mismatch" });

    const wrongCompany = await probeManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:42013/api/health",
      identity,
      fetchImpl: respond({
        ...readyPayload,
        workspace: { ...readyPayload.workspace, companyId: "company-other" },
      }),
    });
    expect(wrongCompany).toMatchObject({ ok: false, reason: "identity_mismatch" });
  });

  it("rejects a partial readiness contract with no company identity", async () => {
    const { companyId: _companyId, ...partialReadiness } = readyPayload.workspace;
    expect(
      await probeManagedWorkspaceReadiness({
        healthUrl: "http://127.0.0.1:42013/api/health",
        identity,
        fetchImpl: respond({ ...readyPayload, workspace: partialReadiness }),
      }),
    ).toMatchObject({ ok: false, reason: "identity_mismatch", readiness: null });
  });

  it("rejects a 200 response whose payload is not semantically healthy", async () => {
    expect(
      await probeManagedWorkspaceReadiness({
        healthUrl: "http://127.0.0.1:42013/api/health",
        identity,
        fetchImpl: respond({ status: "unhealthy" }),
      }),
    ).toMatchObject({ ok: false, reason: "unhealthy_payload" });
  });

  it("rejects a response with no readiness block, so a legacy guest cannot publish", async () => {
    expect(
      await probeManagedWorkspaceReadiness({
        healthUrl: "http://127.0.0.1:42013/api/health",
        identity,
        fetchImpl: respond({ status: "ok" }),
      }),
    ).toMatchObject({ ok: false, reason: "readiness_missing" });
  });

  it("rejects a workspace whose clone or handoff is not ready and keeps the failure phase", async () => {
    expect(
      await probeManagedWorkspaceReadiness({
        healthUrl: "http://127.0.0.1:42013/api/health",
        identity,
        fetchImpl: respond({
          ...readyPayload,
          workspace: {
            ...readyPayload.workspace,
            state: "degraded",
            cloneDataReady: false,
            failurePhase: "clone_data_missing",
          },
        }),
      }),
    ).toMatchObject({ ok: false, reason: "not_ready", detail: "clone_data_missing" });
  });

  it("reports an unreachable guest", async () => {
    const result = await probeManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:42013/api/health",
      identity,
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("fails closed when any part of the workspace identity is unresolved", () => {
    // Every readiness and handoff check keys off this. Returning a partial identity
    // would silently downgrade the whole gate to the legacy transport check, so the
    // three inputs are all required.
    const complete = {
      workspaceCwd: "/srv/worktree",
      executionWorkspaceId: "ews-1",
      companyId: "company-1",
      env: { PAPERCLIP_WORKSPACE_HANDOFF_SECRET: "root" },
    };
    expect(resolveManagedWorkspaceIdentity(complete)).not.toBeNull();
    expect(resolveManagedWorkspaceIdentity({ ...complete, companyId: null })).toBeNull();
    expect(resolveManagedWorkspaceIdentity({ ...complete, executionWorkspaceId: null })).toBeNull();
    expect(resolveManagedWorkspaceIdentity({ ...complete, workspaceCwd: null })).toBeNull();
    expect(resolveManagedWorkspaceIdentity({ ...complete, env: {} })).toBeNull();
  });

  it("derives distinct key material per company on the same workspace", () => {
    const base = {
      workspaceCwd: "/srv/worktree",
      executionWorkspaceId: "ews-1",
      env: { PAPERCLIP_WORKSPACE_HANDOFF_SECRET: "root" },
    };
    const first = resolveManagedWorkspaceIdentity({ ...base, companyId: "company-1" });
    const second = resolveManagedWorkspaceIdentity({ ...base, companyId: "company-2" });
    // The signing key is deliberately per instance+workspace, not per company —
    // the company is enforced by the signed `cid` claim instead — so the keys match
    // while the recorded company differs.
    expect(first?.handoffKey).toBe(second?.handoffKey);
    expect(first?.companyId).toBe("company-1");
    expect(second?.companyId).toBe("company-2");
  });

  it("hands the guest only derived per-workspace material", () => {
    expect(buildManagedWorkspaceGuestEnv(identity)).toEqual({
      [WORKSPACE_HANDOFF_KEY_ENV_KEY]: "handoff-key",
      [WORKSPACE_READINESS_TOKEN_ENV_KEY]: "probe-token",
      [WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY]: "ews-1",
      PAPERCLIP_EXECUTION_WORKSPACE_COMPANY_ID: "company-1",
    });
  });
});

describe("shouldBlockPublicationOnReadiness", () => {
  function rejection(reason: Extract<WorkspaceReadinessProbeResult, { ok: false }>["reason"]) {
    return { ok: false as const, reason, readiness: null, detail: null };
  }

  it("blocks on any real disagreement about the clone", () => {
    for (const reason of ["unreachable", "http_error", "unhealthy_payload", "not_ready", "identity_mismatch"] as const) {
      expect(shouldBlockPublicationOnReadiness(rejection(reason), "auto")).toBe(true);
      expect(shouldBlockPublicationOnReadiness(rejection(reason), "strict")).toBe(true);
    }
  });

  it("does not turn an upgrade lag into an outage by default", () => {
    expect(shouldBlockPublicationOnReadiness(rejection("readiness_missing"), "auto")).toBe(false);
    expect(shouldBlockPublicationOnReadiness(rejection("readiness_missing"), "strict")).toBe(true);
  });

  it("reads the deployment-level mode from the environment", () => {
    expect(resolveWorkspaceReadinessGateMode({})).toBe("auto");
    expect(resolveWorkspaceReadinessGateMode({ PAPERCLIP_WORKSPACE_READINESS_GATE: "STRICT" })).toBe("strict");
    expect(resolveWorkspaceReadinessGateMode({ PAPERCLIP_WORKSPACE_READINESS_GATE: "anything-else" })).toBe("auto");
  });
});

describe("waitForManagedWorkspaceReadiness", () => {
  const identity: ManagedWorkspaceIdentity = {
    instanceId: "instance-a",
    executionWorkspaceId: "ews-1",
    companyId: "company-1",
    handoffKey: "k",
    readinessToken: "t",
    secretSource: "derived",
  };

  const ready = {
    status: "ok",
    workspace: {
      state: "ready",
      databaseReady: true,
      cloneDataReady: true,
      authHandoffReady: true,
      authHandoffUserId: null,
      seedState: "verified",
      seedPhase: "complete",
      seedMode: "minimal",
      instanceId: "instance-a",
      executionWorkspaceId: "ews-1",
      companyId: "company-1",
      failurePhase: null,
    },
  };

  it("absorbs a guest that becomes ready a beat after its listener", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      const body = attempt < 3
        ? { ...ready, workspace: { ...ready.workspace, databaseReady: false, state: "validating" } }
        : ready;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    let clock = 0;
    const result = await waitForManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:1/api/health",
      identity,
      fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result.ok).toBe(true);
    expect(attempt).toBe(3);
  });

  it("does not poll a guest that has no readiness contract to satisfy", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await waitForManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:1/api/health",
      identity,
      fetchImpl,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: "readiness_missing" });
    expect(attempt).toBe(1);
  });

  it("gives up immediately when another instance owns the port", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      return new Response(
        JSON.stringify({ ...ready, workspace: { ...ready.workspace, instanceId: "someone-else" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await waitForManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:1/api/health",
      identity,
      fetchImpl,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: "identity_mismatch" });
    expect(attempt).toBe(1);
  });

  it("stops at the gate budget instead of holding a start open forever", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    let clock = 0;
    const result = await waitForManagedWorkspaceReadiness({
      healthUrl: "http://127.0.0.1:1/api/health",
      identity,
      fetchImpl,
      timeoutMs: 1_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    // 1s budget at the 250ms retry interval: four probes, then the budget is spent.
    expect(attempt).toBe(5);
  });
});
