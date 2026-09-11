import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  principalPermissionGrants,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-hire credential inheritance route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

// The fixed Claude Code OAuth binding. It is a user-secret reference to the
// fixed key. Any other shape is a replacement or a weaker binding.
const FIXED_CLAUDE_OAUTH_BINDING = { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } as const;

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

// The local implicit board actor always passes authorization, so it stands in
// for a user actor without needing a seeded company membership.
function userActor(): Express.Request["actor"] {
  return { type: "board", userId: "local-board", source: "local_implicit" };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("hired agent provider credential inheritance", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-hire-auth-inheritance-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-auth-inheritance-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Auth Inheritance Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParentAgent(companyId: string, adapterType: string, env: Record<string, unknown>) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Parent ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        adapterType,
        adapterConfig: { env },
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
      })
      .returning();
    return row!;
  }

  async function createCompanySecret(companyId: string, value: string) {
    return secretService(db).create(companyId, {
      name: `cred-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
  }

  function secretRef(secretId: string, extra: Record<string, unknown> = {}) {
    return { type: "secret_ref" as const, secretId, ...extra };
  }

  function hire(actor: Express.Request["actor"], companyId: string, payload: Record<string, unknown>) {
    const app = createApp(db, actor);
    return request(app).post(`/api/companies/${companyId}/agent-hires`).send(payload);
  }

  function childEnvOf(res: request.Response): Record<string, unknown> {
    return ((res.body.agent?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env) ?? {};
  }

  it("inherits the parent secret_ref for a codex_local hire with no env, and derives the child binding", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "sk-openai-parent");
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).OPENAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, res.body.agent.id),
        ),
      );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      configPath: "env.OPENAI_API_KEY",
      secretId: secret.id,
      versionSelector: "latest",
    });
  });

  it("keeps a pinned version selector on the copied reference and its derived binding", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "sk-openai-pinned");
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id, { version: 3 }),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex Pinned Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).OPENAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id, version: 3 });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetId, res.body.agent.id),
        ),
      );
    expect(bindings[0]?.versionSelector).toBe("3");
  });

  it("retains version, required, and allowMissingOverride on a copied user_secret_ref", async () => {
    const companyId = await seedCompany();
    await secretService(db).createUserSecretDefinition(companyId, {
      key: "openai_shared_key",
      name: "Shared OpenAI key",
      provider: "local_encrypted",
    });
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: {
        type: "user_secret_ref",
        key: "openai_shared_key",
        version: 2,
        required: false,
        allowMissingOverride: true,
      },
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex User Secret Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).OPENAI_API_KEY).toMatchObject({
      type: "user_secret_ref",
      key: "openai_shared_key",
      version: 2,
      required: false,
      allowMissingOverride: true,
    });
  });

  it("inherits a grok_local parent's XAI_API_KEY reference", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "xai-parent-key");
    const parent = await seedParentAgent(companyId, "grok_local", {
      XAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Grok Child",
      role: "engineer",
      adapterType: "grok_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).XAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id });
  });

  it("inherits a claude_local parent's ANTHROPIC_API_KEY reference", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "ant-parent-key");
    const parent = await seedParentAgent(companyId, "claude_local", {
      ANTHROPIC_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Claude Child",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id });
  });

  it("keeps the child-supplied ANTHROPIC_API_KEY and inherits no Claude credential at all", async () => {
    const companyId = await seedCompany();
    const childSecret = await createCompanySecret(companyId, "ant-child-key");
    // The parent holds the fixed Claude OAuth binding, which is normally
    // inheritable, but the child already supplies its own Claude credential.
    const parent = await seedParentAgent(companyId, "claude_local", {
      CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_CLAUDE_OAUTH_BINDING },
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Claude Child With Own Key",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { env: { ANTHROPIC_API_KEY: secretRef(childSecret.id) } },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    expect(childEnv.ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref", secretId: childSecret.id });
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("does not inherit a plain environment value", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "grok_local", {
      XAI_API_KEY: "xai-plain-value",
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Grok Plain Value Child",
      role: "engineer",
      adapterType: "grok_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).XAI_API_KEY).toBeUndefined();
  });

  it("does not inherit across a mismatched adapter type", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "sk-openai-mismatch");
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Claude Child From Codex Parent",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Object.keys(childEnvOf(res))).toHaveLength(0);
  });

  it("carves out a per-agent CODEX_HOME when the child inherits OPENAI_API_KEY", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "sk-openai-isolated");
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex Isolated Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    // A bare environment string persists as a `plain` binding.
    const codexHome = childEnv.CODEX_HOME as { type: string; value: string } | undefined;
    expect(codexHome?.type).toBe("plain");
    expect(codexHome?.value.length ?? 0).toBeGreaterThan(0);
  });

  it("keeps the shared company Codex home when the child inherits no key", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "codex_local", {});

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex Shared Home Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).CODEX_HOME).toBeUndefined();
  });

  it("adds no home override for a grok_local child with no inherited key", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "grok_local", {});

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Grok No Key Child",
      role: "engineer",
      adapterType: "grok_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    expect(childEnv.GROK_HOME).toBeUndefined();
    expect(childEnv.XAI_API_KEY).toBeUndefined();
  });

  it("inherits nothing for a user actor hire", async () => {
    const companyId = await seedCompany();
    // No hiring-agent context exists for a user actor. The merge must not run
    // at all, so an otherwise-inheritable key is simply never considered.
    const res = await hire(userActor(), companyId, {
      name: "User Hired Child",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Object.keys(childEnvOf(res))).toHaveLength(0);
  });

  it("inherits the fixed Claude OAuth binding, keeps its version, and leaks no token value", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "claude_local", {
      CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_CLAUDE_OAUTH_BINDING, version: 3 },
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Claude OAuth Child",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childAgentId = res.body.agent.id as string;
    expect(childEnvOf(res).CLAUDE_CODE_OAUTH_TOKEN).toMatchObject({
      type: "user_secret_ref",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      version: 3,
    });
    // The response body carries the reference only, never a token value.
    expect(JSON.stringify(res.body)).not.toContain("sk-");

    const declarations = await db
      .select()
      .from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.targetId, childAgentId));
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({
      envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
      versionSelector: "3",
    });

    const hireActivity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.hire_created")));
    expect(hireActivity).toHaveLength(1);
    const detailsText = JSON.stringify(hireActivity[0]!.details);
    expect(detailsText).not.toContain("adapterConfig");
    expect(detailsText).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
