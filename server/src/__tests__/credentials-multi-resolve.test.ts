import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentCredentials,
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  providerCredentials,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  credentialService,
  hasAlternateCredentialOfType,
  isCredentialFailure,
  persistCodexRefreshedTokens,
  recordCredentialFailure,
  resolveAllCredentialEnv,
  selectActiveCredentialForAdapter,
  syncCredentialQuotaCooldown,
  unavailableCredentialPoolsForAdapter,
} from "../services/credentials.js";
import { clearCredentialQuotaCacheForTest, setQuotaSuccessCache } from "../services/credential-quota-cache.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("credentials multi-resolve", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalKey = process.env.PAPERCLIP_CREDENTIAL_KEY;

  beforeAll(async () => {
    process.env.PAPERCLIP_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-creds-multi-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    clearCredentialQuotaCacheForTest();
    await db.delete(costEvents);
    await db.delete(agentCredentials);
    await db.delete(agents);
    await db.delete(providerCredentials);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (originalKey === undefined) delete process.env.PAPERCLIP_CREDENTIAL_KEY;
    else process.env.PAPERCLIP_CREDENTIAL_KEY = originalKey;
  }, 30_000);

  async function setupCompanyAndAgent(adapterType = "acpx_local") {
    const [company] = await db
      .insert(companies)
      .values({
        name: `MultiCred ${randomUUID()}`,
        issuePrefix: `MC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Test Agent",
        adapterType,
      })
      .returning();
    return { company, agent };
  }

  it("does not poison credential health for bad models or request-shape errors", () => {
    expect(isCredentialFailure({ errorCode: "model_not_found", errorMessage: "400 model not supported" })).toBe(false);
    expect(isCredentialFailure({ errorCode: "deepseek_api_request_failed", errorMessage: "invalid_request_error" })).toBe(false);
    expect(isCredentialFailure({ errorMessage: "param incorrect" })).toBe(false);
    expect(isCredentialFailure({ errorMessage: "401 invalid_api_key" })).toBe(true);
    expect(isCredentialFailure({ errorCode: "refresh_token_expired" })).toBe(true);
    for (const errorCode of ["claude_transient_upstream", "codex_transient_upstream", "deepseek_transient_upstream"]) {
      expect(isCredentialFailure({
        errorFamily: "transient_upstream",
        errorCode,
        errorMessage: "429 Too Many Requests: rate limit reached",
      })).toBe(true);
    }
    expect(isCredentialFailure({
      errorFamily: "transient_upstream",
      errorCode: "codex_transient_upstream",
      errorMessage: "The requested model is at capacity",
    })).toBe(false);
    expect(isCredentialFailure({
      errorFamily: "transient_upstream",
      errorCode: "codex_harness_crash",
      errorMessage: "harness exited before a protocol event",
    })).toBe(false);
  });

  it("merges env from claude_oauth (long-lived) and openai_api_key when both are assigned", async () => {
    const { company, agent } = await setupCompanyAndAgent();
    const svc = credentialService(db);

    const claudeCred = await svc.create(company.id, {
      name: "claude-oauth",
      type: "claude_oauth",
      credential: {
        accessToken: "sk-ant-oat-test-long-lived-token",
        tokenKind: "long_lived",
      },
    });
    const openaiCred = await svc.create(company.id, {
      name: "openai-key",
      type: "openai_api_key",
      credential: { apiKey: "sk-openai-test-key" },
    });

    const setResult = await svc.setForAgent(agent.id, [claudeCred.id, openaiCred.id]);
    expect(setResult.ok).toBe(true);

    const resolved = await resolveAllCredentialEnv(db, agent.id);

    expect(resolved.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(resolved.env.HOME).toBeDefined();
    expect(resolved.env.OPENAI_API_KEY).toBe("sk-openai-test-key");
    expect(resolved.env.CURSOR_API_KEY).toBe("sk-openai-test-key");
    expect(resolved.credentialIds).toHaveLength(2);
    expect(resolved.credentialIds).toEqual(expect.arrayContaining([claudeCred.id, openaiCred.id]));
  });

  it("gives a provider-bound OpenAI API key an isolated Codex home", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const credential = await svc.create(company.id, {
      name: "codex-api-key",
      type: "openai_api_key",
      credential: { apiKey: "sk-codex-isolated" },
    });

    const setResult = await svc.setForAgent(agent.id, [credential.id]);
    expect(setResult.ok).toBe(true);

    const resolved = await resolveAllCredentialEnv(db, agent.id);

    expect(resolved.env.OPENAI_API_KEY).toBe("sk-codex-isolated");
    expect(resolved.env.CODEX_HOME).toBeDefined();
    expect(resolved.env.CODEX_HOME!.endsWith(path.join(
      "companies",
      company.id,
      "agents",
      agent.id,
      "codex-home",
    ))).toBe(true);
  });

  it("allows a same-type rotation pool and rotates least-recently-used", async () => {
    const { company, agent } = await setupCompanyAndAgent();
    const svc = credentialService(db);

    const first = await svc.create(company.id, {
      name: "anthropic-1",
      type: "claude_api_key",
      credential: { apiKey: "sk-1" },
    });
    const second = await svc.create(company.id, {
      name: "anthropic-2",
      type: "claude_api_key",
      credential: { apiKey: "sk-2" },
    });

    // Binding two credentials of the same type is now permitted — they form a
    // rotation pool.
    const result = await svc.setForAgent(agent.id, [first.id, second.id]);
    expect(result.ok).toBe(true);

    // Exactly one pool member is chosen per resolve.
    const resolved = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved.chosen).toHaveLength(1);
    expect(resolved.chosen[0].type).toBe("claude_api_key");
    expect(resolved.credentialIds).toHaveLength(1);
    expect([first.id, second.id]).toContain(resolved.chosen[0].credentialId);
    expect(resolved.env.ANTHROPIC_API_KEY).toBeDefined();

    // The chosen credential's lastUsedAt is now set, so the next resolve rotates
    // to the other (least-recently-used) member.
    const firstChoice = resolved.chosen[0].credentialId;
    const resolved2 = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved2.chosen).toHaveLength(1);
    expect(resolved2.chosen[0].credentialId).not.toBe(firstChoice);
  });

  it("never selects a credential whose cached quota is fully depleted", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);

    const lowQuota = await svc.create(company.id, {
      name: "codex-low-quota",
      type: "codex_oauth",
      credential: { accessToken: "codex-low-quota-token" },
    });
    const healthyQuota = await svc.create(company.id, {
      name: "codex-healthy-quota",
      type: "codex_oauth",
      credential: { accessToken: "codex-healthy-quota-token" },
    });

    const setResult = await svc.setForAgent(agent.id, [lowQuota.id, healthyQuota.id]);
    expect(setResult.ok).toBe(true);

    await db
      .update(providerCredentials)
      .set({ lastUsedAt: new Date("2026-04-20T10:00:00.000Z") })
      .where(eq(providerCredentials.id, lowQuota.id));
    await db
      .update(providerCredentials)
      .set({ lastUsedAt: new Date("2026-04-20T11:00:00.000Z") })
      .where(eq(providerCredentials.id, healthyQuota.id));

    setQuotaSuccessCache(lowQuota.id, {
      type: "codex_oauth",
      credentialUpdatedAtMs: lowQuota.updatedAt.getTime(),
      source: "test",
      quotaWindows: [
        { label: "5h", usedPercent: 100, resetsAt: "2099-04-20T15:00:00.000Z", valueLabel: null },
        { label: "Weekly", usedPercent: 45, resetsAt: null, valueLabel: null },
      ],
      sampledAt: new Date().toISOString(),
    });
    setQuotaSuccessCache(healthyQuota.id, {
      type: "codex_oauth",
      credentialUpdatedAtMs: healthyQuota.updatedAt.getTime(),
      source: "test",
      quotaWindows: [
        { label: "5h", usedPercent: 18, resetsAt: null, valueLabel: null },
        { label: "Weekly", usedPercent: 34, resetsAt: null, valueLabel: null },
      ],
      sampledAt: new Date().toISOString(),
    });

    const resolved = await resolveAllCredentialEnv(db, agent.id);

    expect(resolved.chosen).toEqual([{ credentialId: healthyQuota.id, type: "codex_oauth" }]);
    expect(JSON.parse(await fs.readFile(`${resolved.env.CODEX_HOME}/auth.json`, "utf8"))).toMatchObject({
      tokens: {
        access_token: "codex-healthy-quota-token",
      },
    });
  });

  it("returns an unavailable pool instead of routing when every credential is depleted", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const first = await svc.create(company.id, {
      name: "codex-depleted-1",
      type: "codex_oauth",
      credential: { accessToken: "codex-depleted-token-1" },
    });
    const second = await svc.create(company.id, {
      name: "codex-depleted-2",
      type: "codex_oauth",
      credential: { accessToken: "codex-depleted-token-2" },
    });
    expect((await svc.setForAgent(agent.id, [first.id, second.id])).ok).toBe(true);

    for (const credential of [first, second]) {
      setQuotaSuccessCache(credential.id, {
        type: "codex_oauth",
        credentialUpdatedAtMs: credential.updatedAt.getTime(),
        source: "test",
        quotaWindows: [
          { label: "5h", usedPercent: 100, resetsAt: "2099-04-20T15:00:00.000Z", valueLabel: null },
        ],
        sampledAt: new Date().toISOString(),
      });
    }

    const resolved = await resolveAllCredentialEnv(db, agent.id);

    expect(resolved.env).toEqual({});
    expect(resolved.chosen).toEqual([]);
    expect(resolved.unavailablePools).toEqual([{
      type: "codex_oauth",
      reason: "quota_depleted",
      credentialIds: expect.arrayContaining([first.id, second.id]),
      nextEligibleAt: new Date("2099-04-20T15:00:00.000Z"),
    }]);
  });

  it("persists a depleted quota sample so process-cache loss cannot make it eligible", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const credential = await svc.create(company.id, {
      name: "codex-persisted-depletion",
      type: "codex_oauth",
      credential: { accessToken: "codex-persisted-depletion-token" },
    });
    expect((await svc.setForAgent(agent.id, [credential.id])).ok).toBe(true);
    const resetAt = new Date("2099-04-20T15:00:00.000Z");

    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h",
      usedPercent: 100,
      resetsAt: resetAt.toISOString(),
      valueLabel: null,
    }]);
    clearCredentialQuotaCacheForTest();

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved.chosen).toEqual([]);
    expect(resolved.unavailablePools[0]).toMatchObject({
      type: "codex_oauth",
      reason: "quota_depleted",
      nextEligibleAt: resetAt,
    });
  });

  it("does not let an older healthy sample clear newer cross-replica depletion state", async () => {
    const { company } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const credential = await svc.create(company.id, {
      name: "codex-monotonic-quota",
      type: "codex_oauth",
      credential: { accessToken: "codex-monotonic-token" },
    });
    const newerSample = new Date("2030-04-20T15:00:00.000Z");
    const olderSample = new Date("2030-04-20T14:00:00.000Z");
    const resetAt = new Date("2099-04-20T15:00:00.000Z");

    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h limit",
      usedPercent: 100,
      resetsAt: resetAt.toISOString(),
      valueLabel: null,
    }], newerSample);
    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h limit",
      usedPercent: 25,
      resetsAt: resetAt.toISOString(),
      valueLabel: null,
    }], newerSample);
    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h limit",
      usedPercent: 25,
      resetsAt: resetAt.toISOString(),
      valueLabel: null,
    }], olderSample);

    const row = await db
      .select({
        quotaCooldownUntil: providerCredentials.quotaCooldownUntil,
        quotaSampledAt: providerCredentials.quotaSampledAt,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, credential.id))
      .then((rows) => rows[0]);
    expect(row).toEqual({ quotaCooldownUntil: resetAt, quotaSampledAt: newerSample });
  });

  it("does not let an empty or unrecognized quota response clear known depletion", async () => {
    const { company } = await setupCompanyAndAgent("codex_local");
    const credential = await credentialService(db).create(company.id, {
      name: "codex-partial-quota",
      type: "codex_oauth",
      credential: { accessToken: "codex-partial-token" },
    });
    const resetAt = new Date("2099-04-20T15:00:00.000Z");
    const depletedAt = new Date("2030-04-20T15:00:00.000Z");
    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h limit",
      usedPercent: 100,
      resetsAt: resetAt.toISOString(),
      valueLabel: null,
    }], depletedAt);

    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [], new Date(depletedAt.getTime() + 1_000));
    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "Credits",
      usedPercent: null,
      resetsAt: null,
      valueLabel: "$0 remaining",
    }], new Date(depletedAt.getTime() + 2_000));

    const row = await db
      .select({
        quotaCooldownUntil: providerCredentials.quotaCooldownUntil,
        quotaSampledAt: providerCredentials.quotaSampledAt,
        quotaReason: providerCredentials.quotaReason,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, credential.id))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      quotaCooldownUntil: resetAt,
      quotaSampledAt: depletedAt,
      quotaReason: "quota_depleted:codex_oauth",
    });
  });

  it("keeps a depleted credential without a reset blocked until a healthy sample", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const credential = await credentialService(db).create(company.id, {
      name: "codex-open-ended-quota",
      type: "codex_oauth",
      credential: { accessToken: "codex-open-ended-token" },
    });
    expect((await credentialService(db).setForAgent(agent.id, [credential.id])).ok).toBe(true);
    const depletedAt = new Date("2030-04-20T15:00:00.000Z");
    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h limit",
      usedPercent: 100,
      resetsAt: null,
      valueLabel: null,
    }], depletedAt);

    const unavailable = await resolveAllCredentialEnv(db, agent.id);
    expect(unavailable.chosen).toEqual([]);
    expect(unavailable.unavailablePools[0]).toMatchObject({
      reason: "quota_depleted",
      nextEligibleAt: null,
    });

    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h limit",
      usedPercent: 10,
      resetsAt: null,
      valueLabel: null,
    }], new Date(depletedAt.getTime() + 1_000));
    expect((await resolveAllCredentialEnv(db, agent.id)).chosen).toEqual([
      { credentialId: credential.id, type: "codex_oauth" },
    ]);
  });

  it("keeps failure and quota cooldowns independent while a dated quota circuit reaches reset", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const credential = await svc.create(company.id, {
      name: "codex-independent-circuits",
      type: "codex_oauth",
      credential: { accessToken: "codex-independent-token" },
    });
    expect((await svc.setForAgent(agent.id, [credential.id])).ok).toBe(true);
    const failureCooldownUntil = new Date("2099-05-20T15:00:00.000Z");
    await db
      .update(providerCredentials)
      .set({ cooldownUntil: failureCooldownUntil, cooldownReason: "invalid_api_key" })
      .where(eq(providerCredentials.id, credential.id));

    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h limit",
      usedPercent: 100,
      resetsAt: "2099-04-20T15:00:00.000Z",
      valueLabel: null,
    }], new Date("2030-04-20T15:00:00.000Z"));
    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [{
      label: "5h limit",
      usedPercent: 20,
      resetsAt: "2099-04-20T15:00:00.000Z",
      valueLabel: null,
    }], new Date("2030-04-20T16:00:00.000Z"));

    const row = await db
      .select({
        cooldownUntil: providerCredentials.cooldownUntil,
        cooldownReason: providerCredentials.cooldownReason,
        quotaCooldownUntil: providerCredentials.quotaCooldownUntil,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, credential.id))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      cooldownUntil: failureCooldownUntil,
      cooldownReason: "invalid_api_key",
      quotaCooldownUntil: new Date("2099-04-20T15:00:00.000Z"),
    });
    expect((await resolveAllCredentialEnv(db, agent.id)).unavailablePools[0]).toMatchObject({
      reason: "cooldown",
      nextEligibleAt: failureCooldownUntil,
    });
  });

  it("does not turn model-specific or additive quota windows into an account-wide block", async () => {
    const { company } = await setupCompanyAndAgent("claude_local");
    const svc = credentialService(db);
    const credential = await svc.create(company.id, {
      name: "claude-model-specific-quota",
      type: "claude_oauth",
      credential: { accessToken: "claude-model-specific-token" },
    });
    await syncCredentialQuotaCooldown(db, credential.id, credential.type, [
      {
        label: "Current week (Sonnet only)",
        usedPercent: 100,
        resetsAt: "2099-04-20T15:00:00.000Z",
        valueLabel: null,
      },
      {
        label: "Extra usage",
        usedPercent: 100,
        resetsAt: null,
        valueLabel: "$10 / $10",
      },
    ]);

    const row = await db
      .select({ quotaCooldownUntil: providerCredentials.quotaCooldownUntil })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, credential.id))
      .then((rows) => rows[0]);
    expect(row?.quotaCooldownUntil).toBeNull();
  });

  it("does not treat another cooling credential as an immediate failover target", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const first = await svc.create(company.id, {
      name: "codex-cooling-1",
      type: "codex_oauth",
      credential: { accessToken: "codex-cooling-token-1" },
    });
    const second = await svc.create(company.id, {
      name: "codex-cooling-2",
      type: "codex_oauth",
      credential: { accessToken: "codex-cooling-token-2" },
    });
    expect((await svc.setForAgent(agent.id, [first.id, second.id])).ok).toBe(true);
    await db
      .update(providerCredentials)
      .set({ cooldownUntil: new Date("2099-04-20T15:00:00.000Z"), cooldownReason: "provider_quota" })
      .where(eq(providerCredentials.id, second.id));

    await expect(hasAlternateCredentialOfType(
      db,
      agent.id,
      "codex_oauth",
      first.id,
    )).resolves.toBe(false);
  });

  it("does not fail over to another Codex OAuth token for the same quota-depleted account", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const sharedAccountId = "acct-monthly-quota";
    const first = await svc.create(company.id, {
      name: "codex-account-primary",
      type: "codex_oauth",
      credential: { accessToken: "codex-account-primary-token", accountId: sharedAccountId },
    });
    const duplicate = await svc.create(company.id, {
      name: "codex-account-duplicate",
      type: "codex_oauth",
      credential: { accessToken: "codex-account-duplicate-token", accountId: sharedAccountId },
    });
    const distinct = await svc.create(company.id, {
      name: "codex-account-distinct",
      type: "codex_oauth",
      credential: { accessToken: "codex-account-distinct-token", accountId: "acct-healthy" },
    });
    expect((await svc.setForAgent(agent.id, [first.id, duplicate.id, distinct.id])).ok).toBe(true);
    const resetAt = new Date(Date.now() + 60 * 60 * 1000);

    await recordCredentialFailure(db, first.id, {
      kind: "quota",
      reason: "provider_quota",
      providerRetryAfter: resetAt,
    });

    const rows = await db
      .select({ id: providerCredentials.id, quotaCooldownUntil: providerCredentials.quotaCooldownUntil })
      .from(providerCredentials)
      .where(inArray(providerCredentials.id, [first.id, duplicate.id, distinct.id]));
    expect(rows.find((row) => row.id === duplicate.id)?.quotaCooldownUntil).toEqual(resetAt);
    expect(rows.find((row) => row.id === distinct.id)?.quotaCooldownUntil).toBeNull();
    expect(await hasAlternateCredentialOfType(db, agent.id, "codex_oauth", first.id)).toBe(true);

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved.chosen).toEqual([{ credentialId: distinct.id, type: "codex_oauth" }]);
  });

  it("honors an exact provider quota reset beyond the normal cooldown cap", async () => {
    const { company } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const credential = await svc.create(company.id, {
      name: "codex-long-reset",
      type: "codex_oauth",
      credential: { accessToken: "codex-long-reset-token" },
    });
    const providerReset = new Date(Date.now() + 6 * 60 * 60 * 1000);

    const result = await recordCredentialFailure(db, credential.id, {
      kind: "quota",
      reason: "provider_quota",
      providerRetryAfter: providerReset,
    });

    expect(result.cooldownUntil?.getTime()).toBeGreaterThanOrEqual(providerReset.getTime());
    expect(result.disabled).toBe(false);
  });

  it("counts consecutive failures by kind before freezing an auth credential", async () => {
    const { company } = await setupCompanyAndAgent("codex_local");
    const mixed = await credentialService(db).create(company.id, {
      name: "mixed-failure-kinds",
      type: "openai_api_key",
      credential: { apiKey: "sk-mixed" },
    });
    await recordCredentialFailure(db, mixed.id, { kind: "rate_limit", reason: "429" });
    await recordCredentialFailure(db, mixed.id, { kind: "rate_limit", reason: "429" });
    const firstAuth = await recordCredentialFailure(db, mixed.id, { kind: "auth", reason: "invalid_api_key" });
    expect(firstAuth).toMatchObject({ failureCount: 1, disabled: false });

    const authOnly = await credentialService(db).create(company.id, {
      name: "three-auth-failures",
      type: "openai_api_key",
      credential: { apiKey: "sk-auth" },
    });
    expect((await recordCredentialFailure(db, authOnly.id, { kind: "auth", reason: "invalid_api_key" })).disabled).toBe(false);
    expect((await recordCredentialFailure(db, authOnly.id, { kind: "auth", reason: "invalid_api_key" })).disabled).toBe(false);
    expect(await recordCredentialFailure(db, authOnly.id, { kind: "auth", reason: "invalid_api_key" })).toMatchObject({
      failureCount: 3,
      disabled: true,
    });
  });

  it("rejects mixed Codex OAuth and OpenAI API-key credentials for codex agents", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);

    const codexCred = await svc.create(company.id, {
      name: "codex-oauth",
      type: "codex_oauth",
      credential: {
        accessToken: "codex-oauth-access-token",
      },
    });
    const openaiCred = await svc.create(company.id, {
      name: "openai-key",
      type: "openai_api_key",
      credential: { apiKey: "sk-openai-test-key" },
    });

    const setResult = await svc.setForAgent(agent.id, [codexCred.id, openaiCred.id]);
    expect(setResult).toMatchObject({
      ok: false,
      error: "mixed_codex_auth_modes",
    });

    const validation = await svc.validateForAdapterAssignment({
      companyId: company.id,
      adapterType: "codex_local",
      adapterConfig: {},
      credentialIds: [codexCred.id, openaiCred.id],
    });
    expect(validation).toMatchObject({
      ok: false,
      error: "mixed_codex_auth_modes",
    });
  });

  it("reports API-equivalent value and rolling windows for subscription credential usage", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const codexCred = await svc.create(company.id, {
      name: "codex-subscription",
      type: "codex_oauth",
      credential: {
        accessToken: "codex-oauth-access-token",
      },
    });

    await db.insert(costEvents).values([
      {
        companyId: company.id,
        agentId: agent.id,
        credentialId: codexCred.id,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.3-codex",
        inputTokens: 1_000_000,
        cachedInputTokens: 100_000,
        outputTokens: 1_000_000,
        costCents: 0,
        occurredAt: new Date(),
      },
      {
        companyId: company.id,
        agentId: agent.id,
        credentialId: codexCred.id,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.3-codex",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        occurredAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      },
    ]);

    const usage = await svc.usageByCredential(company.id, 30 * 24 * 60 * 60 * 1000);
    const row = usage.find((entry) => entry.credentialId === codexCred.id);
    expect(row).toBeDefined();
    expect(row?.costCents).toBe(0);
    expect(row?.apiEquivalentCostCents).toBeGreaterThan(0);
    expect(row?.subscriptionApiEquivalentCostCents).toBe(row?.apiEquivalentCostCents);
    expect(row?.inputTokens).toBe(2_000_000);
    expect(row?.cachedInputTokens).toBe(100_000);
    expect(row?.outputTokens).toBe(1_000_000);

    const fiveHour = row?.windows.find((window) => window.label === "5h");
    const sevenDay = row?.windows.find((window) => window.label === "7d");
    const thirtyDay = row?.windows.find((window) => window.label === "30d");
    expect(fiveHour?.inputTokens).toBe(1_000_000);
    expect(sevenDay?.inputTokens).toBe(2_000_000);
    expect(thirtyDay?.apiEquivalentCostCents).toBe(row?.apiEquivalentCostCents);
  });

  it("keeps DeepSeek and MiMo gateway usage attributed to their real providers", async () => {
    const { company, agent } = await setupCompanyAndAgent("claude_local");
    const svc = credentialService(db);
    const deepSeekCred = await svc.create(company.id, {
      name: "deepseek",
      type: "deepseek_api_key",
      credential: { apiKey: "sk-deepseek" },
    });
    const mimoCred = await svc.create(company.id, {
      name: "mimo",
      type: "mimo_api_key",
      credential: { apiKey: "sk-mimo" },
    });

    await db.insert(costEvents).values([
      {
        companyId: company.id,
        agentId: agent.id,
        credentialId: deepSeekCred.id,
        provider: "deepseek",
        biller: "deepseek",
        billingType: "metered_api",
        model: "deepseek-v4-flash",
        inputTokens: 1_000_000,
        cachedInputTokens: 100_000,
        outputTokens: 500_000,
        costCents: 28,
        occurredAt: new Date(),
      },
      {
        companyId: company.id,
        agentId: agent.id,
        credentialId: mimoCred.id,
        provider: "mimo",
        biller: "mimo",
        billingType: "credits",
        model: "mimo-v2.5",
        inputTokens: 2_000_000,
        cachedInputTokens: 250_000,
        outputTokens: 1_000_000,
        costCents: 325,
        occurredAt: new Date(),
      },
    ]);

    const usage = await svc.usageByCredential(company.id, 30 * 24 * 60 * 60 * 1000);
    const deepSeek = usage.find((entry) => entry.credentialId === deepSeekCred.id);
    const mimo = usage.find((entry) => entry.credentialId === mimoCred.id);

    expect(deepSeek?.models[0]).toMatchObject({
      provider: "deepseek",
      biller: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(deepSeek?.apiEquivalentCostCents).toBeGreaterThan(0);
    expect(mimo?.models[0]).toMatchObject({
      provider: "mimo",
      biller: "mimo",
      model: "mimo-v2.5",
    });
    expect(mimo?.apiEquivalentCostCents).toBeGreaterThan(0);
  });

  it("attributes codex OpenAI API-key auth to the selected OpenAI credential", () => {
    const active = selectActiveCredentialForAdapter({
      adapterType: "codex_local",
      chosen: [{ credentialId: "openai-cred", type: "openai_api_key" }],
      env: {
        OPENAI_API_KEY: "sk-openai-test-key",
      },
    });

    expect(active).toEqual({ credentialId: "openai-cred", type: "openai_api_key" });
  });

  it("attributes ACPX Codex auth to Codex credentials instead of Claude credentials", () => {
    const active = selectActiveCredentialForAdapter({
      adapterType: "acpx_local",
      adapterConfig: { agent: "codex" },
      chosen: [
        { credentialId: "claude-cred", type: "claude_oauth" },
        { credentialId: "codex-cred", type: "codex_oauth" },
      ],
      env: {
        HOME: "/tmp/paperclip-agent-home",
        CODEX_HOME: "/tmp/paperclip-codex-home",
      },
    });

    expect(active).toEqual({ credentialId: "codex-cred", type: "codex_oauth" });
  });

  it("attributes claude_local Anthropic-compatible gateways to DeepSeek or MiMo credentials", () => {
    const chosen = [
      { credentialId: "claude-oauth", type: "claude_oauth" },
      { credentialId: "claude-api", type: "claude_api_key" },
      { credentialId: "deepseek-cred", type: "deepseek_api_key" },
      { credentialId: "mimo-cred", type: "mimo_api_key" },
    ];

    expect(selectActiveCredentialForAdapter({
      adapterType: "claude_local",
      chosen,
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "sk-deepseek",
        HOME: "/tmp/claude-oauth-home",
      },
    })).toEqual({ credentialId: "deepseek-cred", type: "deepseek_api_key" });

    expect(selectActiveCredentialForAdapter({
      adapterType: "claude_tui",
      chosen,
      env: {
        ANTHROPIC_BASE_URL: "https://token-plan-sgp.xiaomimimo.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "sk-mimo",
        HOME: "/tmp/claude-oauth-home",
      },
    })).toEqual({ credentialId: "mimo-cred", type: "mimo_api_key" });

    expect(selectActiveCredentialForAdapter({
      adapterType: "claude_local",
      chosen,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-api",
        HOME: "/tmp/claude-oauth-home",
      },
    })).toEqual({ credentialId: "claude-api", type: "claude_api_key" });
  });

  it("rotates same-type codex OAuth credentials and writes the selected login to CODEX_HOME", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);

    const first = await svc.create(company.id, {
      name: "codex-oauth-1",
      type: "codex_oauth",
      credential: {
        accessToken: "codex-oauth-access-token-1",
      },
    });
    const second = await svc.create(company.id, {
      name: "codex-oauth-2",
      type: "codex_oauth",
      credential: {
        accessToken: "codex-oauth-access-token-2",
      },
    });

    const setResult = await svc.setForAgent(agent.id, [first.id, second.id]);
    expect(setResult.ok).toBe(true);

    const expectedTokenByCredentialId = new Map([
      [first.id, "codex-oauth-access-token-1"],
      [second.id, "codex-oauth-access-token-2"],
    ]);

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    const active = selectActiveCredentialForAdapter({
      adapterType: "codex_local",
      chosen: resolved.chosen,
      env: resolved.env,
    });

    expect(resolved.chosen).toHaveLength(1);
    expect(resolved.chosen[0].type).toBe("codex_oauth");
    expect(resolved.env.OPENAI_API_KEY).toBeUndefined();
    expect(active).toEqual(resolved.chosen[0]);
    expect(JSON.parse(await fs.readFile(`${resolved.env.CODEX_HOME}/auth.json`, "utf8"))).toMatchObject({
      tokens: {
        access_token: expectedTokenByCredentialId.get(resolved.chosen[0].credentialId),
      },
    });

    const resolved2 = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved2.chosen).toHaveLength(1);
    expect(resolved2.chosen[0].credentialId).not.toBe(resolved.chosen[0].credentialId);
    expect(JSON.parse(await fs.readFile(`${resolved2.env.CODEX_HOME}/auth.json`, "utf8"))).toMatchObject({
      tokens: {
        access_token: expectedTokenByCredentialId.get(resolved2.chosen[0].credentialId),
      },
    });
  });

  it("does not attribute inline codex OpenAI API-key auth to a managed OAuth credential", () => {
    const active = selectActiveCredentialForAdapter({
      adapterType: "codex_local",
      chosen: [{ credentialId: "codex-cred", type: "codex_oauth" }],
      env: {
        CODEX_HOME: "/tmp/paperclip-codex-home",
        OPENAI_API_KEY: "sk-inline",
      },
    });

    expect(active).toBeNull();
  });

  it("resolves MiMo credentials for pi_local using Pi's Xiaomi Token Plan env var", async () => {
    const { company, agent } = await setupCompanyAndAgent("pi_local");
    const svc = credentialService(db);

    const first = await svc.create(company.id, {
      name: "mimo-1",
      type: "mimo_api_key",
      credential: { apiKey: "mimo-key-1" },
    });
    const second = await svc.create(company.id, {
      name: "mimo-2",
      type: "mimo_api_key",
      credential: { apiKey: "mimo-key-2" },
    });

    const setResult = await svc.setForAgent(agent.id, [first.id, second.id]);
    expect(setResult.ok).toBe(true);

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved.chosen).toHaveLength(1);
    expect(resolved.chosen[0].type).toBe("mimo_api_key");
    expect(["mimo-key-1", "mimo-key-2"]).toContain(resolved.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY);
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("writes Pi openai-codex auth for pi_local Codex OAuth credentials", async () => {
    const { company, agent } = await setupCompanyAndAgent("pi_local");
    const svc = credentialService(db);

    const cred = await svc.create(company.id, {
      name: "codex-oauth",
      type: "codex_oauth",
      credential: {
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: 4102444800000,
        accountId: "chatgpt-account-id",
      },
    });

    const setResult = await svc.setForAgent(agent.id, [cred.id]);
    expect(setResult.ok).toBe(true);

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved.env.CODEX_HOME).toBeUndefined();
    expect(resolved.env.PI_CODING_AGENT_DIR).toBeDefined();
    expect(resolved.env.PAPERCLIP_MANAGED_PI_AGENT_DIR).toBe(resolved.env.PI_CODING_AGENT_DIR);

    const auth = JSON.parse(await fs.readFile(`${resolved.env.PI_CODING_AGENT_DIR}/auth.json`, "utf8"));
    expect(auth["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires: 4102444800000,
      accountId: "chatgpt-account-id",
    });
  });

  it("persists refreshed Pi openai-codex tokens back to the managed Codex credential", async () => {
    const { company, agent } = await setupCompanyAndAgent("pi_local");
    const svc = credentialService(db);

    const cred = await svc.create(company.id, {
      name: "codex-oauth",
      type: "codex_oauth",
      credential: {
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: 4102444800000,
        accountId: "chatgpt-account-id",
      },
    });

    const setResult = await svc.setForAgent(agent.id, [cred.id]);
    expect(setResult.ok).toBe(true);

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    const authPath = `${resolved.env.PI_CODING_AGENT_DIR}/auth.json`;
    const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
    auth["openai-codex"] = {
      ...auth["openai-codex"],
      access: "codex-access-token-refreshed",
      refresh: "codex-refresh-token-refreshed",
      expires: 4102444801000,
    };
    await fs.writeFile(authPath, JSON.stringify(auth, null, 2), "utf8");

    await expect(persistCodexRefreshedTokens(db, agent.id, cred.id)).resolves.toEqual({
      updated: true,
    });
    await expect(svc.getDecryptedPayload(cred.id)).resolves.toMatchObject({
      accessToken: "codex-access-token-refreshed",
      refreshToken: "codex-refresh-token-refreshed",
      expiresAt: 4102444801000,
      accountId: "chatgpt-account-id",
    });
  });

  it("attributes pi_local failures to the credential matching the model provider", () => {
    const chosen = [
      { credentialId: "codex-cred", type: "codex_oauth" },
      { credentialId: "openai-cred", type: "openai_api_key" },
      { credentialId: "deepseek-cred", type: "deepseek_api_key" },
      { credentialId: "mimo-cred", type: "mimo_api_key" },
    ];
    const env = {
      PI_CODING_AGENT_DIR: "/tmp/pi-agent",
      OPENAI_API_KEY: "sk-openai",
      DEEPSEEK_API_KEY: "sk-deepseek",
      XIAOMI_TOKEN_PLAN_SGP_API_KEY: "sk-mimo",
    };

    expect(selectActiveCredentialForAdapter({
      adapterType: "pi_local",
      adapterConfig: { model: "deepseek/deepseek-v4-pro" },
      chosen,
      env,
    })).toEqual({ credentialId: "deepseek-cred", type: "deepseek_api_key" });

    expect(selectActiveCredentialForAdapter({
      adapterType: "pi_local",
      adapterConfig: { model: "xiaomi-token-plan-sgp/mimo-v2.5" },
      chosen,
      env,
    })).toEqual({ credentialId: "mimo-cred", type: "mimo_api_key" });

    expect(selectActiveCredentialForAdapter({
      adapterType: "pi_local",
      adapterConfig: { model: "openai-codex/gpt-5.5" },
      chosen,
      env,
    })).toEqual({ credentialId: "codex-cred", type: "codex_oauth" });

    expect(selectActiveCredentialForAdapter({
      adapterType: "pi_local",
      adapterConfig: { model: "openai/gpt-5.4" },
      chosen,
      env,
    })).toEqual({ credentialId: "openai-cred", type: "openai_api_key" });
  });

  it("scopes unavailable Pi pools to the model provider auth lane", () => {
    const pools = [
      {
        type: "codex_oauth",
        reason: "quota_depleted" as const,
        credentialIds: ["codex-depleted"],
        nextEligibleAt: new Date("2099-04-20T15:00:00.000Z"),
      },
      {
        type: "deepseek_api_key",
        reason: "cooldown" as const,
        credentialIds: ["deepseek-cooling"],
        nextEligibleAt: new Date("2099-04-20T16:00:00.000Z"),
      },
    ];

    expect(unavailableCredentialPoolsForAdapter({
      adapterType: "pi_local",
      adapterConfig: { model: "deepseek/deepseek-v4-pro" },
      pools,
    })).toEqual([pools[1]]);
  });

  it("scopes unavailable OpenCode pools to the configured model provider", () => {
    const pools = [
      {
        type: "openai_api_key",
        reason: "cooldown" as const,
        credentialIds: ["openai-cooling"],
        nextEligibleAt: new Date("2099-04-20T15:00:00.000Z"),
      },
      {
        type: "claude_api_key",
        reason: "cooldown" as const,
        credentialIds: ["anthropic-cooling"],
        nextEligibleAt: new Date("2099-04-20T16:00:00.000Z"),
      },
    ];

    expect(unavailableCredentialPoolsForAdapter({
      adapterType: "opencode_local",
      adapterConfig: { model: "anthropic/claude-opus-4" },
      pools,
    })).toEqual([pools[1]]);
  });

  it("does not attribute or block unknown Pi/OpenCode provider lanes with unrelated managed keys", () => {
    const chosen = [{ credentialId: "openai-cred", type: "openai_api_key" }];
    const pools = [{
      type: "openai_api_key",
      reason: "quota_depleted" as const,
      credentialIds: ["openai-cred"],
      nextEligibleAt: new Date("2099-04-20T16:00:00.000Z"),
    }];
    for (const [adapterType, model] of [
      ["pi_local", "custom-provider/model"],
      ["opencode_local", "opencode/model"],
    ] as const) {
      expect(selectActiveCredentialForAdapter({
        adapterType,
        adapterConfig: { model },
        chosen,
        env: { OPENAI_API_KEY: "sk-openai" },
      })).toBeNull();
      expect(unavailableCredentialPoolsForAdapter({
        adapterType,
        adapterConfig: { model },
        pools,
      })).toEqual([]);
    }
  });

  it("falls back to legacy agents.credential_id when the join is empty", async () => {
    const { company, agent } = await setupCompanyAndAgent();
    const svc = credentialService(db);

    const cred = await svc.create(company.id, {
      name: "legacy",
      type: "openai_api_key",
      credential: { apiKey: "sk-legacy" },
    });

    await db
      .update(agents)
      .set({ credentialId: cred.id })
      .where(eq(agents.id, agent.id));

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved.env.OPENAI_API_KEY).toBe("sk-legacy");
    expect(resolved.credentialIds).toEqual([cred.id]);
  });

  it("uses the company default when the agent has no explicit credential assignment", async () => {
    const { company, agent } = await setupCompanyAndAgent("codex_local");
    const svc = credentialService(db);
    const defaultCredential = await svc.create(company.id, {
      name: "company-codex-default",
      type: "openai_api_key",
      credential: { apiKey: "sk-company-default" },
      isDefault: true,
    });

    const resolved = await resolveAllCredentialEnv(db, agent.id);

    expect(resolved.env.OPENAI_API_KEY).toBe("sk-company-default");
    expect(resolved.credentialIds).toEqual([defaultCredential.id]);
  });

  it("does not revive a legacy credential after an explicit empty assignment", async () => {
    const { company, agent } = await setupCompanyAndAgent();
    const svc = credentialService(db);
    const legacy = await svc.create(company.id, {
      name: "legacy-cleared",
      type: "openai_api_key",
      credential: { apiKey: "sk-legacy-cleared" },
    });
    await db.update(agents).set({ credentialId: legacy.id }).where(eq(agents.id, agent.id));

    const setResult = await svc.setForAgent(agent.id, []);
    expect(setResult.ok).toBe(true);
    const resolved = await resolveAllCredentialEnv(db, agent.id);
    const [storedAgent] = await db.select({ credentialId: agents.credentialId }).from(agents).where(eq(agents.id, agent.id));

    expect(storedAgent?.credentialId).toBeNull();
    expect(resolved.env).toEqual({});
    expect(resolved.credentialIds).toEqual([]);
  });

  it("does not let a route allow-list fall through to the legacy credential", async () => {
    const { company, agent } = await setupCompanyAndAgent();
    const svc = credentialService(db);
    const legacy = await svc.create(company.id, {
      name: "legacy-not-allowed",
      type: "openai_api_key",
      credential: { apiKey: "sk-legacy-not-allowed" },
    });
    await db
      .update(agents)
      .set({ credentialId: legacy.id })
      .where(eq(agents.id, agent.id));

    const resolved = await resolveAllCredentialEnv(db, agent.id, null, [randomUUID()]);
    const emptyAllowed = await resolveAllCredentialEnv(db, agent.id, null, []);

    expect(resolved.env).toEqual({});
    expect(resolved.credentialIds).toEqual([]);
    expect(resolved.chosen).toEqual([]);
    expect(emptyAllowed.env).toEqual({});
    expect(emptyAllowed.chosen).toEqual([]);
  });

  it("does not resurrect a legacy credential when current bindings are disabled", async () => {
    const { company, agent } = await setupCompanyAndAgent();
    const svc = credentialService(db);
    const legacy = await svc.create(company.id, {
      name: "legacy-stale",
      type: "openai_api_key",
      credential: { apiKey: "sk-legacy-stale" },
    });
    const assignedDisabled = await svc.create(company.id, {
      name: "assigned-disabled",
      type: "claude_api_key",
      credential: { apiKey: "sk-assigned-disabled" },
    });
    await db.update(agents).set({ credentialId: legacy.id }).where(eq(agents.id, agent.id));
    expect((await svc.setForAgent(agent.id, [assignedDisabled.id])).ok).toBe(true);
    await db
      .update(providerCredentials)
      .set({ disabledAt: new Date(), disabledReason: "test disabled" })
      .where(eq(providerCredentials.id, assignedDisabled.id));

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved.env).toEqual({});
    expect(resolved.chosen).toEqual([]);
  });

  it("does not resolve a disabled legacy agents.credential_id", async () => {
    const { company, agent } = await setupCompanyAndAgent();
    const svc = credentialService(db);

    const cred = await svc.create(company.id, {
      name: "legacy-disabled",
      type: "openai_api_key",
      credential: { apiKey: "sk-disabled" },
    });

    await db
      .update(providerCredentials)
      .set({
        disabledAt: new Date(),
        disabledReason: "test freeze",
      })
      .where(eq(providerCredentials.id, cred.id));
    await db
      .update(agents)
      .set({ credentialId: cred.id })
      .where(eq(agents.id, agent.id));

    const resolved = await resolveAllCredentialEnv(db, agent.id);
    expect(resolved.env).toEqual({});
    expect(resolved.credentialIds).toEqual([]);
    expect(resolved.chosen).toEqual([]);
  });
});
