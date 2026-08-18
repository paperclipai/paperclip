import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  claudeSetupTokenSessions,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  environments,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import {
  assertClaudeOAuthBindingInvariant,
  CLAUDE_OAUTH_CLAIM_REJECTED,
  CLAUDE_OAUTH_CREDENTIAL_CONFLICT,
  claudeOAuthClaimRejectedError,
  isFixedClaudeOAuthBinding,
  secretService,
} from "../services/secrets.js";
import {
  createDbSetupTokenCleanupStore,
  type SetupTokenSessionScope,
} from "../services/setup-token-session.js";
import { createSetupTokenSecretWriter } from "../services/setup-token-transport-binding.js";

// The fixed Claude Code OAuth binding. It is a user-secret reference to the
// fixed key. Any other shape is a replacement or a weaker binding.
const FIXED_BINDING = { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } as const;
const withEnv = (env: Record<string, unknown>) => ({ env });

// --- The pure server-enforced binding invariant (no database) ----------------

describe("assertClaudeOAuthBindingInvariant", () => {
  it("reports that a create introduces the fixed binding", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "claude_local",
      nextConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING }),
      priorConfig: null,
    });
    expect(decision).toEqual({ introducesBinding: true, keepsBinding: false });
  });

  it("reports that a write keeps an existing fixed binding", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "claude_local",
      nextConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING }),
      priorConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING }),
    });
    expect(decision).toEqual({ introducesBinding: false, keepsBinding: true });
  });

  it("permits a normal removal of the fixed binding", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "claude_local",
      nextConfig: withEnv({}),
      priorConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING }),
    });
    expect(decision).toEqual({ introducesBinding: false, keepsBinding: false });
  });

  it("permits a normal plain-value replacement of the fixed binding", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "claude_local",
      nextConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "sk-fake" } }),
      priorConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING }),
    });
    expect(decision).toEqual({ introducesBinding: false, keepsBinding: false });
  });

  it("permits a re-point to a different user-secret key", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "claude_local",
      nextConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: { type: "user_secret_ref", key: "OTHER" } }),
      priorConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING }),
    });
    expect(decision).toEqual({ introducesBinding: false, keepsBinding: false });
  });

  it("permits a re-point to a company-secret reference", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "claude_local",
      nextConfig: withEnv({
        CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
      }),
      priorConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING }),
    });
    expect(decision).toEqual({ introducesBinding: false, keepsBinding: false });
  });

  it("permits a removal of the fixed binding by a move to another adapter type", () => {
    // The prior config has the fixed binding on claude_local. The write moves
    // the agent to the process adapter and drops the binding in the same write.
    // The binding behaves like a normal environment variable, so the write is
    // allowed and reports no fixed binding.
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "process",
      nextConfig: withEnv({}),
      priorConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING }),
    });
    expect(decision).toEqual({ introducesBinding: false, keepsBinding: false });
  });

  it("does nothing for a non-claude_local create with no prior fixed binding", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "process",
      nextConfig: withEnv({}),
      priorConfig: withEnv({ SOME_OTHER_KEY: { type: "plain", value: "x" } }),
    });
    expect(decision).toEqual({ introducesBinding: false, keepsBinding: false });
  });

  it("rejects the fixed binding together with a plain ANTHROPIC_API_KEY and names no value", () => {
    let thrown: Error | null = null;
    try {
      assertClaudeOAuthBindingInvariant({
        adapterType: "claude_local",
        nextConfig: withEnv({
          CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING,
          ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-secret" },
        }),
        priorConfig: null,
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(CLAUDE_OAUTH_CREDENTIAL_CONFLICT);
    expect(thrown?.message).not.toContain("sk-ant-secret");
    expect(thrown?.message).not.toContain("ANTHROPIC_API_KEY");
  });

  it("rejects the fixed binding together with an ANTHROPIC_API_KEY secret reference", () => {
    expect(() =>
      assertClaudeOAuthBindingInvariant({
        adapterType: "claude_local",
        nextConfig: withEnv({
          CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING,
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
        }),
        priorConfig: null,
      }),
    ).toThrowError(CLAUDE_OAUTH_CREDENTIAL_CONFLICT);
  });

  it("ignores an empty ANTHROPIC_API_KEY plain value", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "claude_local",
      nextConfig: withEnv({
        CLAUDE_CODE_OAUTH_TOKEN: FIXED_BINDING,
        ANTHROPIC_API_KEY: { type: "plain", value: "   " },
      }),
      priorConfig: null,
    });
    expect(decision.introducesBinding).toBe(true);
  });

  it("does nothing for a non-claude_local adapter", () => {
    const decision = assertClaudeOAuthBindingInvariant({
      adapterType: "codex_local",
      nextConfig: withEnv({ CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "anything" } }),
      priorConfig: null,
    });
    expect(decision).toEqual({ introducesBinding: false, keepsBinding: false });
  });

  it("recognizes only the exact fixed binding shape", () => {
    expect(isFixedClaudeOAuthBinding(FIXED_BINDING)).toBe(true);
    expect(isFixedClaudeOAuthBinding({ type: "plain", value: "x" })).toBe(false);
    expect(isFixedClaudeOAuthBinding({ type: "user_secret_ref", key: "OTHER" })).toBe(false);
    expect(isFixedClaudeOAuthBinding(null)).toBe(false);
  });

  it("raises a fixed 409 claim error", () => {
    const error = claudeOAuthClaimRejectedError();
    expect(error.status).toBe(409);
    expect(error.message).toBe(CLAUDE_OAUTH_CLAIM_REJECTED);
  });
});

// --- The stored-session claim on the create and hire paths (Postgres) --------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Claude OAuth binding claim tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("agent service Claude OAuth binding claim", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let connectionString!: string;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-claude-oauth-binding-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("claude-oauth-binding");
    stopDb = started.cleanup;
    connectionString = started.connectionString;
    db = createDb(connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
    await db.delete(claudeSetupTokenSessions);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  interface Scope {
    companyId: string;
    environmentId: string;
    ownerUserId: string;
  }

  async function seedScope(): Promise<Scope> {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: `sandbox-${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "fake" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, environmentId, ownerUserId: `user-${randomUUID().slice(0, 8)}` };
  }

  async function seedStoredClaim(scope: Scope, deadlineMs: number, state = "stored"): Promise<string> {
    const sessionId = randomUUID();
    await createDbSetupTokenCleanupStore(db).record({
      sessionId,
      companyId: scope.companyId,
      ownerUserId: scope.ownerUserId,
      adapterType: "claude_local",
      environmentId: scope.environmentId,
      leaseId: "lease-1",
      deadline: deadlineMs,
      state: state as never,
      boundAt: null,
    });
    return sessionId;
  }

  function createInput(scope: Scope, extraEnv: Record<string, unknown> = {}) {
    return {
      name: "Claude Login Agent",
      role: "engineer",
      status: "idle" as const,
      adapterType: "claude_local",
      defaultEnvironmentId: scope.environmentId,
      adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_BINDING }, ...extraEnv } },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    };
  }

  async function readClaim(sessionId: string) {
    const rows = await db
      .select()
      .from(claudeSetupTokenSessions)
      .where(eq(claudeSetupTokenSessions.sessionId, sessionId));
    return rows[0];
  }

  async function countAgents(companyId: string): Promise<number> {
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    return rows.length;
  }

  // Seed one stored owner value for the fixed Claude OAuth definition. The
  // apply-existing path binds the fixed reference only when this value exists.
  async function seedStoredOwnerValue(scope: Scope, value = "sk-owner-token"): Promise<void> {
    await secretService(db).completeClaudeOAuthUserSecret(scope.companyId, scope.ownerUserId, {
      sessionId: randomUUID(),
      mode: "first_write",
      value,
    });
  }

  async function countUserSecretDefinitions(companyId: string): Promise<number> {
    const rows = await db
      .select()
      .from(userSecretDefinitions)
      .where(eq(userSecretDefinitions.companyId, companyId));
    return rows.length;
  }

  async function countDeclarationsForAgent(agentId: string): Promise<number> {
    const rows = await db
      .select()
      .from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.targetId, agentId));
    return rows.length;
  }

  it("inserts the fixed binding and consumes a valid claim exactly once", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);

    const created = await agentService(db).create(scope.companyId, createInput(scope), {
      claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
    });

    const persisted = created.adapterConfig as { env: Record<string, unknown> };
    expect(persisted.env.CLAUDE_CODE_OAUTH_TOKEN).toMatchObject({
      type: "user_secret_ref",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    // The claim is consumed once.
    expect((await readClaim(sessionId))?.boundAt).not.toBeNull();

    // A replay of the same claim inserts no second agent.
    await expect(
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });
    expect(await countAgents(scope.companyId)).toBe(1);
  });

  it("rejects a missing claim and inserts no binding", async () => {
    const scope = await seedScope();
    await expect(
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { storedSessionId: undefined, ownerUserId: scope.ownerUserId },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });
    expect(await countAgents(scope.companyId)).toBe(0);
  });

  it("rejects a foreign-owner claim and leaves it unconsumed", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);
    await expect(
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { storedSessionId: sessionId, ownerUserId: "intruder" },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });
    expect((await readClaim(sessionId))?.boundAt).toBeNull();
    expect(await countAgents(scope.companyId)).toBe(0);
  });

  it("rejects an expired claim and leaves it unconsumed", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() - 1_000);
    await expect(
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });
    expect((await readClaim(sessionId))?.boundAt).toBeNull();
  });

  it("rejects a non-stored claim and leaves it unconsumed", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000, "awaiting_code");
    await expect(
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });
    expect((await readClaim(sessionId))?.boundAt).toBeNull();
  });

  it("returns a byte-identical error for every reject reason", async () => {
    const messages: string[] = [];
    // Missing claim.
    const missingScope = await seedScope();
    messages.push(
      await agentService(db)
        .create(missingScope.companyId, createInput(missingScope), {
          claudeLogin: { storedSessionId: undefined, ownerUserId: missingScope.ownerUserId },
        })
        .then(() => "no-error")
        .catch((error: Error) => error.message),
    );
    // Foreign owner.
    const foreignScope = await seedScope();
    const foreignSession = await seedStoredClaim(foreignScope, Date.now() + 60_000);
    messages.push(
      await agentService(db)
        .create(foreignScope.companyId, createInput(foreignScope), {
          claudeLogin: { storedSessionId: foreignSession, ownerUserId: "intruder" },
        })
        .then(() => "no-error")
        .catch((error: Error) => error.message),
    );
    // Expired.
    const expiredScope = await seedScope();
    const expiredSession = await seedStoredClaim(expiredScope, Date.now() - 1_000);
    messages.push(
      await agentService(db)
        .create(expiredScope.companyId, createInput(expiredScope), {
          claudeLogin: { storedSessionId: expiredSession, ownerUserId: expiredScope.ownerUserId },
        })
        .then(() => "no-error")
        .catch((error: Error) => error.message),
    );
    // Non-stored.
    const nonStoredScope = await seedScope();
    const nonStoredSession = await seedStoredClaim(nonStoredScope, Date.now() + 60_000, "submitting");
    messages.push(
      await agentService(db)
        .create(nonStoredScope.companyId, createInput(nonStoredScope), {
          claudeLogin: { storedSessionId: nonStoredSession, ownerUserId: nonStoredScope.ownerUserId },
        })
        .then(() => "no-error")
        .catch((error: Error) => error.message),
    );
    // Already consumed.
    const consumedScope = await seedScope();
    const consumedSession = await seedStoredClaim(consumedScope, Date.now() + 60_000);
    await agentService(db).create(consumedScope.companyId, createInput(consumedScope), {
      claudeLogin: { storedSessionId: consumedSession, ownerUserId: consumedScope.ownerUserId },
    });
    messages.push(
      await agentService(db)
        .create(consumedScope.companyId, createInput(consumedScope), {
          claudeLogin: { storedSessionId: consumedSession, ownerUserId: consumedScope.ownerUserId },
        })
        .then(() => "no-error")
        .catch((error: Error) => error.message),
    );

    expect(new Set(messages)).toEqual(new Set([CLAUDE_OAUTH_CLAIM_REJECTED]));
  });

  it("consumes one claim exactly once under two concurrent creates", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);

    const results = await Promise.allSettled([
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
      }),
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(CLAUDE_OAUTH_CLAIM_REJECTED);
    expect(await countAgents(scope.companyId)).toBe(1);
  });

  it("inserts no binding when the claim row lock holds until after the deadline", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 3_600_000);

    const lockDb = createDb(connectionString);
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const lockHeld = lockDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT bound_at FROM claude_setup_token_sessions WHERE session_id = ${sessionId} FOR UPDATE`,
      );
      await tx.execute(
        sql`UPDATE claude_setup_token_sessions SET deadline_at = clock_timestamp() + interval '300 milliseconds' WHERE session_id = ${sessionId}`,
      );
      signalLocked();
      await gate;
    });

    await locked;
    const createPromise = agentService(db)
      .create(scope.companyId, createInput(scope), {
        claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
      })
      .then(() => "created")
      .catch((error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 600));
    releaseGate();
    await lockHeld;

    expect(await createPromise).toBe(CLAUDE_OAUTH_CLAIM_REJECTED);
    expect((await readClaim(sessionId))?.boundAt).toBeNull();
    expect(await countAgents(scope.companyId)).toBe(0);
    await lockDb.$client.end();
  });

  it("removes the fixed binding on a normal update", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);
    const created = await agentService(db).create(scope.companyId, createInput(scope), {
      claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
    });

    const updated = await agentService(db).update(created.id, { adapterConfig: { env: {} } });

    const updatedEnv = (updated?.adapterConfig as { env: Record<string, unknown> }).env;
    expect(updatedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("re-points the binding to a plain value on a normal update", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);
    const created = await agentService(db).create(scope.companyId, createInput(scope), {
      claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
    });

    const updated = await agentService(db).update(created.id, {
      adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "sk-fake" } } },
    });

    const updatedEnv = (updated?.adapterConfig as { env: Record<string, unknown> }).env;
    expect(updatedEnv.CLAUDE_CODE_OAUTH_TOKEN).toMatchObject({ type: "plain", value: "sk-fake" });
  });

  it("removes the binding by a move to another adapter type on a normal update", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);
    const created = await agentService(db).create(scope.companyId, createInput(scope), {
      claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
    });

    // The write moves the agent to the process adapter and drops the binding in
    // the same PATCH. The binding is a normal environment variable, so the write
    // succeeds and drops both the fixed binding and the claude_local adapter.
    const updated = await agentService(db).update(created.id, {
      adapterType: "process",
      adapterConfig: { env: {} },
    });

    expect(updated?.adapterType).toBe("process");
    const updatedEnv = (updated?.adapterConfig as { env: Record<string, unknown> }).env;
    expect(updatedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("keeps an existing binding when the update changes another field", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);
    const created = await agentService(db).create(scope.companyId, createInput(scope), {
      claudeLogin: { storedSessionId: sessionId, ownerUserId: scope.ownerUserId },
    });

    const updated = await agentService(db).update(created.id, {
      adapterConfig: { model: "claude-opus", env: { CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_BINDING } } },
    });
    const env = (updated?.adapterConfig as { env: Record<string, unknown> }).env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toMatchObject(FIXED_BINDING);
  });

  it("rejects a newly introduced binding on update, because it carries no claim", async () => {
    const scope = await seedScope();
    const created = await agentService(db).create(scope.companyId, {
      name: "Api Key Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      defaultEnvironmentId: scope.environmentId,
      adapterConfig: { env: {} },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await expect(
      agentService(db).update(created.id, {
        adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_BINDING } } },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });

    const reloaded = await agentService(db).getById(created.id);
    const reloadedEnv = (reloaded?.adapterConfig as { env: Record<string, unknown> }).env;
    expect(reloadedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // --- The user-actor apply-existing path (no login round trip) --------------

  it("binds the fixed reference from a stored owner value with no claim", async () => {
    const scope = await seedScope();
    await seedStoredOwnerValue(scope);

    const created = await agentService(db).create(scope.companyId, createInput(scope), {
      claudeLogin: { ownerUserId: scope.ownerUserId, applyExistingWithoutClaim: true },
    });

    const persisted = created.adapterConfig as { env: Record<string, unknown> };
    expect(persisted.env.CLAUDE_CODE_OAUTH_TOKEN).toMatchObject({
      type: "user_secret_ref",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    // The response carries the reference only. It carries no token value.
    expect(JSON.stringify(created)).not.toContain("sk-owner-token");
    expect(await countAgents(scope.companyId)).toBe(1);
    // The path consumes no setup-token claim, so it needs no login round trip.
    const claims = await db.select().from(claudeSetupTokenSessions);
    expect(claims).toHaveLength(0);
  });

  it("binds on a hire-shaped create that needs board approval", async () => {
    const scope = await seedScope();
    await seedStoredOwnerValue(scope);

    const created = await agentService(
      db,
    ).create(scope.companyId, { ...createInput(scope), status: "pending_approval" }, {
      claudeLogin: { ownerUserId: scope.ownerUserId, applyExistingWithoutClaim: true },
    });

    expect(created.status).toBe("pending_approval");
    const persisted = created.adapterConfig as { env: Record<string, unknown> };
    expect(persisted.env.CLAUDE_CODE_OAUTH_TOKEN).toMatchObject(FIXED_BINDING);
  });

  it("binds the fixed reference on an update from a stored owner value with no claim", async () => {
    const scope = await seedScope();
    await seedStoredOwnerValue(scope);
    const created = await agentService(db).create(scope.companyId, {
      name: "Claude Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      defaultEnvironmentId: scope.environmentId,
      adapterConfig: { env: {} },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const updated = await agentService(db).update(
      created.id,
      { adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_BINDING } } } },
      { claudeLogin: { ownerUserId: scope.ownerUserId, applyExistingWithoutClaim: true } },
    );

    const env = (updated?.adapterConfig as { env: Record<string, unknown> }).env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toMatchObject(FIXED_BINDING);
  });

  it("rejects apply-existing when the owner has no stored value and binds nothing", async () => {
    const scope = await seedScope();

    await expect(
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { ownerUserId: scope.ownerUserId, applyExistingWithoutClaim: true },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });

    // A rejected bind creates neither the agent nor the fixed definition.
    expect(await countAgents(scope.companyId)).toBe(0);
    expect(await countUserSecretDefinitions(scope.companyId)).toBe(0);
  });

  it("rejects apply-existing when no owner is derived (an agent actor)", async () => {
    const scope = await seedScope();
    await seedStoredOwnerValue(scope);

    // The route sets no owner for an agent actor. The gate rejects the no-claim
    // bind, so an agent actor never binds the fixed reference.
    await expect(
      agentService(db).create(scope.companyId, createInput(scope), {
        claudeLogin: { ownerUserId: null, applyExistingWithoutClaim: true },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });
    expect(await countAgents(scope.companyId)).toBe(0);
  });

  it("rejects apply-existing when the stored value belongs to another company", async () => {
    const ownerScope = await seedScope();
    await seedStoredOwnerValue(ownerScope);
    // The same owner, a different company. The owner value is company-scoped, so
    // the status read finds nothing for the foreign company.
    const foreignScope = await seedScope();
    foreignScope.ownerUserId = ownerScope.ownerUserId;

    await expect(
      agentService(db).create(foreignScope.companyId, createInput(foreignScope), {
        claudeLogin: { ownerUserId: foreignScope.ownerUserId, applyExistingWithoutClaim: true },
      }),
    ).rejects.toMatchObject({ message: CLAUDE_OAUTH_CLAIM_REJECTED });
    expect(await countAgents(foreignScope.companyId)).toBe(0);
  });

  it("binds nothing from the flag alone when the config carries no fixed binding", async () => {
    const scope = await seedScope();
    await seedStoredOwnerValue(scope);

    // The apply-existing flag is set, but the config carries no fixed binding. The
    // gate mints the fixed reference only when the client presents the exact fixed
    // binding, so the flag alone binds nothing and creates no fixed definition.
    const created = await agentService(db).create(
      scope.companyId,
      {
        name: "Plain Agent",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        defaultEnvironmentId: scope.environmentId,
        adapterConfig: { env: {} },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { claudeLogin: { ownerUserId: scope.ownerUserId, applyExistingWithoutClaim: true } },
    );

    const env = (created.adapterConfig as { env: Record<string, unknown> }).env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(await countDeclarationsForAgent(created.id)).toBe(0);
  });

  it("derives the persisted binding shape, so a client secret selector never rides through", async () => {
    const scope = await seedScope();
    await seedStoredOwnerValue(scope);

    // A client adds a secret id and a foreign owner to the binding. The persist
    // normalization keeps only the fixed reference fields, so the extra selectors
    // never reach the stored binding. The runtime derives the owner from context.
    const created = await agentService(db).create(
      scope.companyId,
      createInput(scope, {
        CLAUDE_CODE_OAUTH_TOKEN: {
          type: "user_secret_ref",
          key: "CLAUDE_CODE_OAUTH_TOKEN",
          secretId: "attacker-secret",
          ownerUserId: "intruder",
        },
      }),
      { claudeLogin: { ownerUserId: scope.ownerUserId, applyExistingWithoutClaim: true } },
    );

    const binding = (created.adapterConfig as { env: Record<string, Record<string, unknown>> }).env
      .CLAUDE_CODE_OAUTH_TOKEN;
    expect(binding).toMatchObject({ type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(binding.secretId).toBeUndefined();
    expect(binding.ownerUserId).toBeUndefined();
  });

  it("resolves the bound reference to the stored value without leaking it in a log", async () => {
    const scope = await seedScope();
    await seedStoredOwnerValue(scope, "sk-secret-resolve");
    const created = await agentService(db).create(scope.companyId, createInput(scope), {
      claudeLogin: { ownerUserId: scope.ownerUserId, applyExistingWithoutClaim: true },
    });

    // The successful bind writes a declaration for the agent, so the fixed
    // reference resolves at runtime. The declaration and the definition carry no
    // token value.
    expect(await countDeclarationsForAgent(created.id)).toBe(1);
    const definitions = await db.select().from(userSecretDefinitions);
    expect(JSON.stringify(definitions)).not.toContain("sk-secret-resolve");
  });

  // --- The atomic credential-claim writer (item 2) ---------------------------

  function claimScope(scope: Scope): SetupTokenSessionScope {
    return {
      companyId: scope.companyId,
      ownerUserId: scope.ownerUserId,
      targetAgentId: null,
      adapterType: "claude_local",
      environmentId: scope.environmentId,
    };
  }

  it("commits the stored transition and the secret together on a first write", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000, "submitting");
    const writer = createSetupTokenSecretWriter({ db });

    await writer({ scope: claimScope(scope), sessionId, token: "sk-ant-oat01-FIRSTWRITE" });

    // The durable row transitioned to `stored` and stays unconsumed.
    const claim = await readClaim(sessionId);
    expect(claim?.state).toBe("stored");
    expect(claim?.boundAt).toBeNull();
    // The owner value committed in the same transaction.
    const status = await secretService(db).readClaudeOAuthUserSecretStatus(
      scope.companyId,
      scope.ownerUserId,
    );
    expect(status).not.toBeNull();
    expect(status?.latestVersion).toBe(1);
  });

  it("rolls back the transition and writes no secret when the secret write fails", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000, "submitting");
    // Inject a completion that fails after the transition. The whole transaction
    // rolls back, so neither the claim nor the secret commits.
    const writer = createSetupTokenSecretWriter({
      db,
      completionForTx: () => ({
        async completeClaudeOAuthUserSecret() {
          throw new Error("storage down");
        },
      }),
    });

    await expect(
      writer({ scope: claimScope(scope), sessionId, token: "sk-ant-oat01-ROLLBACK" }),
    ).rejects.toThrow();

    const claim = await readClaim(sessionId);
    expect(claim?.state).toBe("submitting");
    expect(claim?.boundAt).toBeNull();
    expect(
      await secretService(db).readClaudeOAuthUserSecretStatus(scope.companyId, scope.ownerUserId),
    ).toBeNull();
    expect(await countUserSecretDefinitions(scope.companyId)).toBe(0);
  });

  it("writes no secret for an expired claim", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() - 1_000, "submitting");
    const writer = createSetupTokenSecretWriter({ db });

    await expect(
      writer({ scope: claimScope(scope), sessionId, token: "sk-ant-oat01-EXPIRED" }),
    ).rejects.toThrow();

    expect((await readClaim(sessionId))?.state).toBe("submitting");
    expect(
      await secretService(db).readClaudeOAuthUserSecretStatus(scope.companyId, scope.ownerUserId),
    ).toBeNull();
  });

  it("writes no secret for an already-consumed claim", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);
    // Consume the stored claim first, so `bound_at` is set and the predecessor
    // predicate no longer matches.
    await createDbSetupTokenCleanupStore(db).consumeStoredClaim({
      sessionId,
      companyId: scope.companyId,
      ownerUserId: scope.ownerUserId,
      adapterType: "claude_local",
      environmentId: scope.environmentId,
    });
    const writer = createSetupTokenSecretWriter({ db });

    await expect(
      writer({ scope: claimScope(scope), sessionId, token: "sk-ant-oat01-BOUND" }),
    ).rejects.toThrow();

    expect(
      await secretService(db).readClaudeOAuthUserSecretStatus(scope.companyId, scope.ownerUserId),
    ).toBeNull();
  });

  it("rotates the stored value under the captured version on a confirmed overwrite", async () => {
    const scope = await seedScope();
    await seedStoredOwnerValue(scope, "sk-old-value");
    const before = await secretService(db).readClaudeOAuthUserSecretStatus(
      scope.companyId,
      scope.ownerUserId,
    );
    expect(before).not.toBeNull();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000, "submitting");
    const writer = createSetupTokenSecretWriter({ db });

    await writer({
      scope: {
        ...claimScope(scope),
        confirmedOverwrite: {
          expectedSecretId: before!.secretId,
          expectedLatestVersion: before!.latestVersion,
        },
      },
      sessionId,
      token: "sk-ant-oat01-ROTATED",
    });

    // The claim transitioned and the stored value rotated to a new version.
    expect((await readClaim(sessionId))?.state).toBe("stored");
    const after = await secretService(db).readClaudeOAuthUserSecretStatus(
      scope.companyId,
      scope.ownerUserId,
    );
    expect(after?.secretId).toBe(before!.secretId);
    expect(after?.latestVersion).toBe(before!.latestVersion + 1);
  });

  it("deletes a cleanup row only under the full owner scope", async () => {
    const scope = await seedScope();
    const sessionId = await seedStoredClaim(scope, Date.now() + 60_000);
    const store = createDbSetupTokenCleanupStore(db);
    const identity = {
      sessionId,
      companyId: scope.companyId,
      ownerUserId: scope.ownerUserId,
      adapterType: "claude_local",
      environmentId: scope.environmentId,
    };

    // A foreign-owner identity with the right session id does not delete the row.
    await store.remove({ ...identity, ownerUserId: "intruder" });
    expect(await readClaim(sessionId)).toBeTruthy();

    // The full-scope identity deletes the row.
    await store.remove(identity);
    expect(await readClaim(sessionId)).toBeUndefined();
  });
});
