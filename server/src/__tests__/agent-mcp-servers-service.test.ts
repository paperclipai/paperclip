import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentMcpServers,
  companies,
  companySecrets,
  companySecretBindings,
  companySecretVersions,
  createDb,
} from "@paperclipai/db";
import { agentMcpServerService, type McpActor } from "../services/agent-mcp-servers.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor: McpActor = { actorType: "user", actorId: "board" };

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agentMcpServerService (MCP auto-install, issue #2)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentMcpServerService>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `atelier-mcp-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("atelier-mcp-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    svc = agentMcpServerService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentMcpServers);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atelier",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("provisions a stdio server from an approval, binding secrets by reference (never plaintext)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const approvalId = randomUUID();
    const server = await svc.provisionFromApproval(
      companyId,
      agentId,
      {
        name: "browser",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@acme/browser-mcp"],
        reason: "need a browser",
        env: [
          { key: "BROWSER_TOKEN", secretName: "browser-token" },
          { key: "HEADLESS", value: "true" },
        ],
        secretValues: { "browser-token": "s3cr3t-value" },
      },
      boardActor,
      approvalId,
    );
    expect(server.status).toBe("enabled");
    expect(server.sourceApprovalId).toBe(approvalId);

    // The stored binding for the secret is a reference, NOT the plaintext value.
    const [stored] = await svc.list(companyId, agentId, { includeDisabled: true });
    const tokenBinding = stored.envBindings.BROWSER_TOKEN as Record<string, unknown>;
    expect(tokenBinding.type).toBe("secret_ref");
    expect(JSON.stringify(stored.envBindings)).not.toContain("s3cr3t-value");
    expect(stored.envBindings.HEADLESS).toBe("true");

    // At run time the secret resolves into the process env for the adapter.
    const runtime = await svc.buildRuntimeMcpServers(companyId, agentId);
    expect(runtime).toHaveLength(1);
    expect(runtime[0]).toMatchObject({ name: "browser", transport: "stdio", command: "npx" });
    expect(runtime[0].env?.BROWSER_TOKEN).toBe("s3cr3t-value");
    expect(runtime[0].env?.HEADLESS).toBe("true");
  });

  it("resolves http transport secrets into request headers", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await svc.provisionFromApproval(
      companyId,
      agentId,
      {
        name: "hosted",
        transport: "http",
        url: "https://mcp.example.com/sse",
        reason: "hosted server",
        env: [{ key: "Authorization", secretName: "hosted-key" }],
        secretValues: { "hosted-key": "Bearer abc123" },
      },
      boardActor,
      randomUUID(),
    );
    const runtime = await svc.buildRuntimeMcpServers(companyId, agentId);
    expect(runtime).toHaveLength(1);
    expect(runtime[0]).toMatchObject({ name: "hosted", transport: "http", url: "https://mcp.example.com/sse" });
    expect(runtime[0].headers?.Authorization).toBe("Bearer abc123");
  });

  it("reinstalling the same server name updates in place (atomic upsert, single row)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await svc.create(
      companyId,
      agentId,
      { name: "browser", transport: "stdio", command: "node", args: ["old.js"], reason: "v1", env: [] },
      boardActor,
    );
    await svc.create(
      companyId,
      agentId,
      { name: "browser", transport: "stdio", command: "npx", args: ["-y", "new"], reason: "v2", env: [] },
      boardActor,
    );
    const all = await svc.list(companyId, agentId, { includeDisabled: true });
    expect(all).toHaveLength(1);
    expect((all[0].config as { command?: string }).command).toBe("npx");
  });

  it("excludes disabled servers from the runtime set but keeps them listable", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const server = await svc.create(
      companyId,
      agentId,
      { name: "tool", transport: "stdio", command: "node", args: ["x.js"], reason: "x", env: [] },
      boardActor,
    );
    expect(await svc.buildRuntimeMcpServers(companyId, agentId)).toHaveLength(1);

    await svc.setStatus(companyId, agentId, server.id, "disabled");
    expect(await svc.buildRuntimeMcpServers(companyId, agentId)).toHaveLength(0);
    expect(await svc.list(companyId, agentId)).toHaveLength(0); // enabled-only
    expect(await svc.list(companyId, agentId, { includeDisabled: true })).toHaveLength(1);
  });
});
