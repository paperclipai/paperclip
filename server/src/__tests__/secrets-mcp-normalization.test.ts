import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secrets-mcp tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secretService — mcpServers binding normalization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const PLAINTEXT_VALUE = "plain-secret-value";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secrets-mcp-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedSecret(companyId: string, name = "linear-api-key") {
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name,
      provider: "local_encrypted",
      value: PLAINTEXT_VALUE,
      description: null,
      externalRef: null,
    });
    return secret.id;
  }

  it("normalizes a plain string env inside mcpServers.*.env", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, {
      mcpServers: {
        linear: { type: "stdio", command: "mcp-linear", args: [], env: { FOO: "bar" } },
      },
    });
    expect((out as any).mcpServers.linear.env.FOO).toEqual({ type: "plain", value: "bar" });
  });

  it("preserves a well-formed secret_ref inside mcpServers.*.env", async () => {
    const companyId = await seedCompany();
    const secretId = await seedSecret(companyId);
    const svc = secretService(db);
    const ref = { type: "secret_ref" as const, secretId, version: "latest" as const };
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, {
      mcpServers: {
        linear: { type: "stdio", command: "mcp-linear", env: { K: ref } },
      },
    });
    expect((out as any).mcpServers.linear.env.K).toEqual(ref);
  });

  it("rejects a secret_ref pointing at a different company's secret", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const otherSecretId = await seedSecret(companyB);
    const svc = secretService(db);
    await expect(
      svc.normalizeAdapterConfigForPersistence(companyA, {
        mcpServers: {
          linear: {
            type: "stdio",
            command: "mcp-linear",
            env: {
              K: { type: "secret_ref" as const, secretId: otherSecretId, version: "latest" as const },
            },
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("normalizes a plain string header inside mcpServers.*.headers", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, {
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer abc" },
        },
      },
    });
    expect((out as any).mcpServers.linear.headers.Authorization).toEqual({
      type: "plain",
      value: "Bearer abc",
    });
  });

  it("does not touch top-level env when mcpServers also has env", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, {
      env: { TOP: "level" },
      mcpServers: { linear: { type: "stdio", command: "mcp-linear", env: { K: "v" } } },
    });
    expect((out as any).env.TOP).toEqual({ type: "plain", value: "level" });
    expect((out as any).mcpServers.linear.env.K).toEqual({ type: "plain", value: "v" });
  });

  it("resolves secret_ref inside mcpServers.*.env at runtime", async () => {
    const companyId = await seedCompany();
    const secretId = await seedSecret(companyId);
    const svc = secretService(db);
    const config = {
      mcpServers: {
        linear: {
          type: "stdio",
          command: "mcp-linear",
          env: {
            LINEAR_API_KEY: { type: "secret_ref" as const, secretId, version: "latest" as const },
          },
        },
      },
    };
    const { config: resolved, secretKeys } = await svc.resolveAdapterConfigForRuntime(
      companyId,
      config,
    );
    expect((resolved as any).mcpServers.linear.env.LINEAR_API_KEY).toBe(PLAINTEXT_VALUE);
    expect(secretKeys.has("LINEAR_API_KEY")).toBe(true);
  });

  it("resolves secret_ref inside mcpServers.*.headers at runtime", async () => {
    const companyId = await seedCompany();
    const secretId = await seedSecret(companyId);
    const svc = secretService(db);
    const config = {
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: {
            Authorization: { type: "secret_ref" as const, secretId, version: "latest" as const },
          },
        },
      },
    };
    const { config: resolved, secretKeys } = await svc.resolveAdapterConfigForRuntime(
      companyId,
      config,
    );
    expect((resolved as any).mcpServers.linear.headers.Authorization).toBe(PLAINTEXT_VALUE);
    expect(secretKeys.has("Authorization")).toBe(true);
  });

  it("leaves mcpServers untouched when the field is absent", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, {
      env: { K: "v" },
    });
    expect((out as any).mcpServers).toBeUndefined();
  });

  it("preserves non-binding fields on each mcp server entry", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, {
      mcpServers: {
        linear: {
          type: "stdio",
          command: "mcp-linear",
          args: ["--flag"],
          env: { K: "v" },
        },
      },
    });
    expect((out as any).mcpServers.linear.command).toBe("mcp-linear");
    expect((out as any).mcpServers.linear.args).toEqual(["--flag"]);
  });
});
