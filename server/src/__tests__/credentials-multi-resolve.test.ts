import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentCredentials,
  agents,
  companies,
  companyMemberships,
  createDb,
  providerCredentials,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  credentialService,
  persistCodexRefreshedTokens,
  resolveAllCredentialEnv,
  selectActiveCredentialForAdapter,
} from "../services/credentials.js";

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
