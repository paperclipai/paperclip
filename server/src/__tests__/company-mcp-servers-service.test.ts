import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  agents,
  companies,
  companyMcpServers,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  companyMcpServerService,
  readAgentMcpServerRefs,
  writeAgentMcpServerRefs,
} from "../services/company-mcp-servers.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("agent MCP server refs helpers", () => {
  it("reads, dedupes, and trims refs", () => {
    expect(readAgentMcpServerRefs({ mcpServerRefs: ["linear", " linear ", "", "files", 3] })).toEqual([
      "linear",
      "files",
    ]);
    expect(readAgentMcpServerRefs({})).toEqual([]);
    expect(readAgentMcpServerRefs(null)).toEqual([]);
  });

  it("writes refs and removes the key when empty", () => {
    expect(writeAgentMcpServerRefs({ env: {} }, ["linear"])).toEqual({
      env: {},
      mcpServerRefs: ["linear"],
    });
    expect(writeAgentMcpServerRefs({ mcpServerRefs: ["linear"] }, [])).toEqual({});
  });
});

describeEmbeddedPostgres("companyMcpServerService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-company-mcp-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("company-mcp");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companyMcpServers);
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

  async function seedAgent(companyId: string, refs: string[] = []) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Bot-${agentId.slice(0, 6)}`,
      role: "general",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: refs.length > 0 ? { mcpServerRefs: refs } : {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return agentId;
  }

  it("creates, lists with usage counts, and sanitizes secrets in responses", async () => {
    const companyId = await seedCompany();
    const svc = companyMcpServerService(db);
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `linear-${randomUUID()}`,
      provider: "local_encrypted",
      value: "lin_api_secret",
    });

    await svc.create(companyId, {
      name: "linear",
      description: "Linear issue tracking",
      config: {
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: {
          Authorization: { type: "secret_ref", secretId: secret.id },
          "X-Env": "prod",
        },
      },
    });
    await seedAgent(companyId, ["linear"]);
    await seedAgent(companyId, []);

    const listed = await svc.list(companyId);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("linear");
    expect(listed[0].attachedAgentCount).toBe(1);
    expect(listed[0].oauthConnected).toBe(false);
    const headers = (listed[0].config as { headers: Record<string, unknown> }).headers;
    expect(headers.Authorization).toMatchObject({ type: "secret_ref", secretId: secret.id });
    expect(headers["X-Env"]).toEqual({ type: "plain", value: "prod" });

    // Catalog secret bindings recorded under the mcp_server target.
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.targetType, "mcp_server"),
          like(companySecretBindings.configPath, "mcpServers.linear.%"),
        ),
      );
    expect(bindings).toHaveLength(1);
  });

  it("rejects duplicate names and unknown refs", async () => {
    const companyId = await seedCompany();
    const svc = companyMcpServerService(db);
    await svc.create(companyId, {
      name: "files",
      config: { transport: "stdio", command: "npx", args: ["-y", "files-mcp"] },
    });
    await expect(
      svc.create(companyId, { name: "files", config: { transport: "stdio", command: "npx" } }),
    ).rejects.toThrow(/already exists/i);
    await expect(svc.resolveRequestedNames(companyId, ["files", "nope"])).rejects.toThrow(
      /Unknown MCP server: nope/i,
    );
    await expect(svc.resolveRequestedNames(companyId, ["files"])).resolves.toEqual(["files"]);
  });

  it("renames follow through to agent refs", async () => {
    const companyId = await seedCompany();
    const svc = companyMcpServerService(db);
    const created = await svc.create(companyId, {
      name: "linear",
      config: { transport: "http", url: "https://mcp.linear.app/mcp" },
    });
    const agentId = await seedAgent(companyId, ["linear", "other"]);

    await svc.update(companyId, created.id, { name: "linear-mcp" });

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(readAgentMcpServerRefs(agentRow.adapterConfig)).toEqual(["linear-mcp", "other"]);
  });

  it("blocks delete while in use, force-cascades refs", async () => {
    const companyId = await seedCompany();
    const svc = companyMcpServerService(db);
    const created = await svc.create(companyId, {
      name: "linear",
      config: { transport: "http", url: "https://mcp.linear.app/mcp" },
    });
    const agentId = await seedAgent(companyId, ["linear"]);

    const blocked = await svc.remove(companyId, created.id);
    expect(blocked.ok).toBe(false);

    const forced = await svc.remove(companyId, created.id, { force: true });
    expect(forced.ok).toBe(true);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(readAgentMcpServerRefs(agentRow.adapterConfig)).toEqual([]);
  });

  it("expands enabled catalog refs into run config with inline overrides winning", async () => {
    const companyId = await seedCompany();
    const svc = companyMcpServerService(db);
    await svc.create(companyId, {
      name: "linear",
      config: { transport: "http", url: "https://mcp.linear.app/mcp" },
    });
    await svc.create(companyId, {
      name: "files",
      config: { transport: "stdio", command: "npx", args: ["-y", "files-mcp"] },
    });
    const disabled = await svc.create(companyId, {
      name: "off",
      config: { transport: "http", url: "https://off.example.com/mcp" },
    });
    await svc.update(companyId, disabled.id, { enabled: false });

    const expanded = await svc.expandAgentMcpServers(companyId, {
      mcpServerRefs: ["linear", "files", "off"],
      mcpServers: {
        linear: { transport: "http", url: "https://override.example.com/mcp" },
      },
    });
    const servers = expanded.mcpServers as Record<string, { url?: string; command?: string }>;
    expect(Object.keys(servers).sort()).toEqual(["files", "linear"]);
    // Inline per-agent definition wins over the catalog entry.
    expect(servers.linear.url).toBe("https://override.example.com/mcp");
    expect(servers.files.command).toBe("npx");

    // No refs -> config untouched.
    const untouched = await svc.expandAgentMcpServers(companyId, { env: {} });
    expect(untouched).toEqual({ env: {} });
  });

  it("snapshot reports missing refs", async () => {
    const companyId = await seedCompany();
    const svc = companyMcpServerService(db);
    await svc.create(companyId, {
      name: "linear",
      config: { transport: "http", url: "https://mcp.linear.app/mcp" },
    });
    const snapshot = await svc.snapshotForAgent(companyId, {
      mcpServerRefs: ["linear", "ghost"],
    });
    expect(snapshot.desiredMcpServers).toEqual(["linear", "ghost"]);
    expect(snapshot.missing).toEqual(["ghost"]);
  });

  it("update with stale oauth secretId null preserves the connected secret", async () => {
    const companyId = await seedCompany();
    const svc = companyMcpServerService(db);
    const secrets = secretService(db);
    const tokenSecret = await secrets.create(companyId, {
      name: `mcp-oauth-${randomUUID()}`,
      provider: "local_encrypted",
      value: JSON.stringify({ accessToken: "at" }),
    });
    const created = await svc.create(companyId, {
      name: "linear",
      config: {
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        auth: { type: "oauth", secretId: tokenSecret.id },
      },
    });

    const updated = await svc.update(companyId, created.id, {
      config: {
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        auth: { type: "oauth", secretId: null },
      },
    });
    const auth = (updated.config as { auth?: { secretId?: string | null } }).auth;
    expect(auth?.secretId).toBe(tokenSecret.id);
  });
});
