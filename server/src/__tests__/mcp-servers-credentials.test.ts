import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, mcpServers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { mcpServerService, unsealMcpServerCredential } from "../services/mcp-servers.js";
import { secretService } from "../services/secrets.js";

// localEncryptedProvider reads the master key lazily on first seal/unseal.
process.env.PAPERCLIP_SECRETS_MASTER_KEY =
  "a3f1c2d4e5b6978811223344556677889900aabbccddeeff0011223344556677";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres MCP server credential tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PLAINTEXT_CREDENTIAL = "super-secret-token-do-not-store";
const SEAL_PREFIX = "paperclip-mcp-credential:";

describeEmbeddedPostgres("mcpServerService encrypted credentials", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof mcpServerService>;

  beforeAll(async () => {
    // startEmbeddedPostgresTestDatabase applies the full migration journal,
    // so a passing beforeAll proves 0111_mcp_server_registry applies on a
    // fresh DB after 0000..0110 (the existing-DB upgrade path).
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-servers-cred-");
    db = createDb(tempDb.connectionString);
    svc = mcpServerService(db, { secrets: secretService(db) });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `MCP Cred Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("migration produced credential_secret_ref and enabled default false", async () => {
    const columns = await db.execute(sql`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'mcp_servers' AND column_name IN ('credential_secret_ref', 'enabled')
      ORDER BY column_name
    `);
    const rows = Array.from(columns as Iterable<Record<string, unknown>>);
    const byName = new Map(rows.map((row) => [row.column_name, row]));
    expect(byName.get("credential_secret_ref")?.is_nullable).toBe("YES");
    expect(String(byName.get("enabled")?.column_default)).toBe("false");
  });

  it("roundtrips a server row with a sealed credential ref and no plaintext", async () => {
    const companyId = await createCompany();

    const created = await svc.create(companyId, {
      name: "Test Server",
      slug: "test-server",
      transport: "stdio",
      command: "echo",
      credential: PLAINTEXT_CREDENTIAL,
    });

    // enabled defaults to false per NEO-350
    expect(created.enabled).toBe(false);

    // Sealed ref persisted, plaintext never stored anywhere in the row.
    expect(created.credentialSecretRef).toMatch(new RegExp(`^${SEAL_PREFIX}`));
    expect(JSON.stringify(created)).not.toContain(PLAINTEXT_CREDENTIAL);

    const [raw] = await db.select().from(mcpServers).where(eq(mcpServers.id, created.id));
    expect(raw.credentialSecretRef).toBe(created.credentialSecretRef);
    expect(JSON.stringify(raw)).not.toContain(PLAINTEXT_CREDENTIAL);

    // The sealed ref decrypts back to the original value.
    await expect(unsealMcpServerCredential(raw.credentialSecretRef!)).resolves.toBe(
      PLAINTEXT_CREDENTIAL,
    );

    // Read path returns the same sealed ref.
    const fetched = await svc.getById(created.id);
    expect(fetched?.credentialSecretRef).toBe(created.credentialSecretRef);

    // Update reseals with fresh material; update to null clears.
    const rotated = await svc.update(created.id, { credential: "rotated-secret" });
    expect(rotated?.credentialSecretRef).toMatch(new RegExp(`^${SEAL_PREFIX}`));
    expect(rotated?.credentialSecretRef).not.toBe(created.credentialSecretRef);
    await expect(unsealMcpServerCredential(rotated!.credentialSecretRef!)).resolves.toBe(
      "rotated-secret",
    );

    const untouched = await svc.update(created.id, { description: "keep credential" });
    expect(untouched?.credentialSecretRef).toBe(rotated?.credentialSecretRef);

    const cleared = await svc.update(created.id, { credential: null });
    expect(cleared?.credentialSecretRef).toBeNull();
  });

  it("scopes list() by company", async () => {
    const companyA = await createCompany();
    const companyB = await createCompany();

    await svc.create(companyA, {
      name: "A Server",
      slug: "a-server",
      transport: "http",
      url: "https://mcp.example.com/a",
      credential: "company-a-token",
    });
    await svc.create(companyB, {
      name: "B Server",
      slug: "b-server",
      transport: "sse",
      url: "https://mcp.example.com/b",
    });

    const forA = await svc.list(companyA);
    expect(forA.map((server) => server.slug)).toEqual(["a-server"]);
    expect(forA.every((server) => server.companyId === companyA)).toBe(true);

    const forB = await svc.list(companyB);
    expect(forB.map((server) => server.slug)).toEqual(["b-server"]);
  });
});
