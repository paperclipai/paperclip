import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping MCP secrets tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secretService — external MCP servers", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-mcp-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secrets-mcp");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
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

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  describe("normalizeMcpServersForPersistence", () => {
    it("canonicalizes plain strings and passes secret refs through", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db);
      const secret = await svc.create(companyId, {
        name: `linear-${randomUUID()}`,
        provider: "local_encrypted",
        value: "lin_api_secret",
      });

      const normalized = await svc.normalizeMcpServersForPersistence(companyId, {
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: {
            Authorization: { type: "secret_ref", secretId: secret.id },
            "X-Env": "prod",
          },
        },
      });

      const linear = normalized.linear as {
        headers: Record<string, unknown>;
      };
      expect(linear.headers.Authorization).toEqual({
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      });
      expect(linear.headers["X-Env"]).toEqual({ type: "plain", value: "prod" });
    });

    it("rejects cross-company secret refs", async () => {
      const companyA = await seedCompany("A");
      const companyB = await seedCompany("B");
      const svc = secretService(db);
      const foreign = await svc.create(companyB, {
        name: `foreign-${randomUUID()}`,
        provider: "local_encrypted",
        value: "v",
      });

      await expect(
        svc.normalizeMcpServersForPersistence(companyA, {
          linear: {
            transport: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: { type: "secret_ref", secretId: foreign.id } },
          },
        }),
      ).rejects.toThrow(/same company/i);
    });

    it("rejects invalid configs and redacted placeholders", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db);

      await expect(
        svc.normalizeMcpServersForPersistence(companyId, {
          "bad name!": { transport: "http", url: "https://x.example/mcp" },
        }),
      ).rejects.toThrow(/Invalid MCP server config/i);

      await expect(
        svc.normalizeMcpServersForPersistence(companyId, {
          linear: { transport: "http", url: "ftp://x.example/mcp" },
        }),
      ).rejects.toThrow(/Invalid MCP server config/i);

      await expect(
        svc.normalizeMcpServersForPersistence(companyId, {
          linear: {
            transport: "http",
            url: "https://x.example/mcp",
            headers: { Authorization: "***REDACTED***" },
          },
        }),
      ).rejects.toThrow(/redacted placeholder/i);
    });

    it("enforces strict mode for sensitive plain values", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db);

      await expect(
        svc.normalizeMcpServersForPersistence(
          companyId,
          {
            linear: {
              transport: "http",
              url: "https://x.example/mcp",
              headers: { Authorization: "Bearer inline-token" },
            },
          },
          { strictMode: true },
        ),
      ).rejects.toThrow(/Strict secret mode/i);
    });
  });

  describe("syncMcpBindingsForTarget", () => {
    it("replace-sets mcpServers.* bindings and leaves env.* bindings intact", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db);
      const secret = await svc.create(companyId, {
        name: `tok-${randomUUID()}`,
        provider: "local_encrypted",
        value: "v1",
      });
      const agentId = randomUUID();

      await svc.createBinding({
        companyId,
        secretId: secret.id,
        targetType: "agent",
        targetId: agentId,
        configPath: "env.API_KEY",
      });

      await svc.syncMcpBindingsForTarget(
        companyId,
        { targetType: "agent", targetId: agentId },
        {
          linear: {
            transport: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: { type: "secret_ref", secretId: secret.id } },
          },
          files: {
            transport: "stdio",
            command: "npx",
            env: { FILES_TOKEN: { type: "secret_ref", secretId: secret.id, version: 1 } },
          },
        },
      );

      const mcpBindings = await db
        .select()
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.targetId, agentId),
            like(companySecretBindings.configPath, "mcpServers.%"),
          ),
        );
      expect(mcpBindings.map((binding) => binding.configPath).sort()).toEqual([
        "mcpServers.files.env.FILES_TOKEN",
        "mcpServers.linear.headers.Authorization",
      ]);

      const envBindings = await db
        .select()
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.targetId, agentId),
            like(companySecretBindings.configPath, "env.%"),
          ),
        );
      expect(envBindings).toHaveLength(1);

      // Replace-set: dropping linear removes its binding.
      await svc.syncMcpBindingsForTarget(
        companyId,
        { targetType: "agent", targetId: agentId },
        {
          files: {
            transport: "stdio",
            command: "npx",
            env: { FILES_TOKEN: { type: "secret_ref", secretId: secret.id } },
          },
        },
      );
      const remaining = await db
        .select()
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.targetId, agentId),
            like(companySecretBindings.configPath, "mcpServers.%"),
          ),
        );
      expect(remaining.map((binding) => binding.configPath)).toEqual([
        "mcpServers.files.env.FILES_TOKEN",
      ]);
    });
  });

  describe("resolveAdapterConfigForRuntime — mcpServers", () => {
    it("resolves secret refs, drops disabled servers, and builds bearer headers", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db);
      const headerSecret = await svc.create(companyId, {
        name: `hdr-${randomUUID()}`,
        provider: "local_encrypted",
        value: "lin_api_secret",
      });
      const bearerSecret = await svc.create(companyId, {
        name: `bearer-${randomUUID()}`,
        provider: "local_encrypted",
        value: "tok_bearer",
      });

      const { config } = await svc.resolveAdapterConfigForRuntime(companyId, {
        env: {},
        mcpServers: {
          linear: {
            transport: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: { type: "secret_ref", secretId: headerSecret.id } },
          },
          other: {
            transport: "sse",
            url: "https://sse.example.com/mcp",
            auth: { type: "bearer", token: { type: "secret_ref", secretId: bearerSecret.id } },
          },
          off: { transport: "http", url: "https://off.example.com/mcp", enabled: false },
          files: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "files-mcp"],
            env: { PLAIN: "x" },
          },
        },
      });

      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(Object.keys(servers).sort()).toEqual(["files", "linear", "other"]);
      expect((servers.linear.headers as Record<string, string>).Authorization).toBe("lin_api_secret");
      expect((servers.other.headers as Record<string, string>).Authorization).toBe("Bearer tok_bearer");
      expect(servers.files).toMatchObject({
        transport: "stdio",
        command: "npx",
        args: ["-y", "files-mcp"],
        env: { PLAIN: "x" },
      });
    });

    it("extracts access tokens from oauth JSON secret payloads", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db);
      const oauthSecret = await svc.create(companyId, {
        name: `oauth-${randomUUID()}`,
        provider: "local_encrypted",
        value: JSON.stringify({
          accessToken: "oauth-access-tok",
          refreshToken: "r",
          expiresAt: 4102444800000,
        }),
      });

      const { config } = await svc.resolveAdapterConfigForRuntime(companyId, {
        mcpServers: {
          linear: {
            transport: "http",
            url: "https://mcp.linear.app/mcp",
            auth: { type: "oauth", secretId: oauthSecret.id },
          },
        },
      });

      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect((servers.linear.headers as Record<string, string>).Authorization).toBe(
        "Bearer oauth-access-tok",
      );
    });
  });
});
