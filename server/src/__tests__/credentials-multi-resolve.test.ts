import { randomBytes, randomUUID } from "node:crypto";
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
import { credentialService, resolveAllCredentialEnv } from "../services/credentials.js";

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
    await db.delete(providerCredentials);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (originalKey === undefined) delete process.env.PAPERCLIP_CREDENTIAL_KEY;
    else process.env.PAPERCLIP_CREDENTIAL_KEY = originalKey;
  });

  async function setupCompanyAndAgent() {
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
        adapterType: "acpx_local",
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

    expect(resolved.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-test-long-lived-token");
    expect(resolved.env.OPENAI_API_KEY).toBe("sk-openai-test-key");
    expect(resolved.env.CURSOR_API_KEY).toBe("sk-openai-test-key");
    expect(resolved.credentialIds).toHaveLength(2);
    expect(resolved.credentialIds).toEqual(expect.arrayContaining([claudeCred.id, openaiCred.id]));
  });

  it("rejects assigning two credentials of the same provider type", async () => {
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

    const result = await svc.setForAgent(agent.id, [first.id, second.id]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("duplicate_type");
    expect(result.type).toBe("claude_api_key");
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
});
