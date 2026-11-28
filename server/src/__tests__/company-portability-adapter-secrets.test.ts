import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, companySecretBindings, companySecrets, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres adapter secret portability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company portability adapter config secrets", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-portability-adapter-secrets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("portability-adapter-secrets");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function exportHermesGatewayCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hermes Source",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const created = await createAgentLifecycle(db).requestHire(companyId, {
      name: "Hermes Gateway",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {
        apiBaseUrl: "https://hermes.example",
        apiKey: `hermes-key-${randomUUID()}`,
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const [source] = await db.select().from(agents).where(eq(agents.id, created.id));
    const sourceApiKey = (source!.adapterConfig as Record<string, unknown>).apiKey as {
      type: string;
      secretId: string;
    };
    expect(sourceApiKey.type).toBe("secret_ref");

    const exported = await companyPortabilityService(db).exportBundle(companyId, {
      include: { company: true, agents: true, projects: false, issues: false },
    });
    return { exported, sourceSecretId: sourceApiKey.secretId };
  }

  async function importAsNewCompany(
    exported: Awaited<ReturnType<typeof exportHermesGatewayCompany>>["exported"],
    secretValues?: Record<string, string>,
    adapterOverrides?: Record<string, {
      adapterType: string;
      adapterConfig?: Record<string, unknown>;
    }>,
  ) {
    const result = await companyPortabilityService(db).importBundle(
      {
        source: { type: "inline", rootPath: exported.rootPath, files: exported.files },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: `Hermes Target ${randomUUID()}` },
        collisionStrategy: "rename",
        secretValues,
        adapterOverrides,
      },
      "user-1",
    );
    const [imported] = await db.select().from(agents).where(eq(agents.companyId, result.company.id));
    return { companyId: result.company.id, agent: imported! };
  }

  it("exports the gateway credential as a secret input and imports the package into a new company", async () => {
    const { exported, sourceSecretId } = await exportHermesGatewayCompany();

    expect(JSON.stringify(exported)).not.toContain(sourceSecretId);
    expect(exported.manifest.envInputs).toEqual([
      {
        key: "apiKey",
        description: "Provide apiKey for agent hermes-gateway",
        agentSlug: "hermes-gateway",
        projectSlug: null,
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      },
    ]);

    const { agent } = await importAsNewCompany(exported);

    expect(agent.adapterType).toBe("hermes_gateway");
    expect(agent.adapterConfig).toMatchObject({ apiBaseUrl: "https://hermes.example" });
    expect(agent.adapterConfig).not.toHaveProperty("apiKey");
  });

  it("binds a provided gateway credential to the imported adapter config", async () => {
    const { exported, sourceSecretId } = await exportHermesGatewayCompany();

    const { companyId, agent } = await importAsNewCompany(exported, {
      "agent:hermes-gateway:apiKey": "hermes-imported-key",
    });

    const importedApiKey = (agent.adapterConfig as Record<string, unknown>).apiKey as {
      type: string;
      secretId: string;
    };
    expect(importedApiKey.type).toBe("secret_ref");
    expect(importedApiKey.secretId).not.toBe(sourceSecretId);
    expect(agent.adapterConfig).not.toHaveProperty("env");

    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, importedApiKey.secretId));
    expect(secret?.companyId).toBe(companyId);

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agent.id),
      ));
    expect(bindings.map((binding) => binding.configPath)).toEqual(["apiKey"]);

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      agent.adapterConfig as Record<string, unknown>,
      { consumerType: "agent", consumerId: agent.id },
      { adapterType: "hermes_gateway" },
    );
    expect(resolved.config.apiKey).toBe("hermes-imported-key");
  });

  it("keeps a provided gateway credential when the adapter config is overridden", async () => {
    const { exported } = await exportHermesGatewayCompany();

    const { companyId, agent } = await importAsNewCompany(
      exported,
      { "agent:hermes-gateway:apiKey": "hermes-override-key" },
      {
        "hermes-gateway": {
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: "https://override.example" },
        },
      },
    );

    const importedApiKey = (agent.adapterConfig as Record<string, unknown>).apiKey as {
      type: string;
      secretId: string;
    };
    expect(agent.adapterConfig).toMatchObject({
      apiBaseUrl: "https://override.example",
      apiKey: { type: "secret_ref" },
    });

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      agent.adapterConfig as Record<string, unknown>,
      { consumerType: "agent", consumerId: agent.id },
      { adapterType: "hermes_gateway" },
    );
    expect(resolved.config.apiKey).toBe("hermes-override-key");
    expect(importedApiKey.secretId).toBeTruthy();
  });
});
