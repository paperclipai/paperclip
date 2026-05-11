import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agents, agentSshIdentities, companies } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-ssh-identities-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

function connect(connectionString: string) {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema: { agents, agentSshIdentities, companies } });
  cleanups.push(async () => {
    await sql.end();
  });
  return db;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent_ssh_identities tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent_ssh_identities", () => {
  it(
    "inserts and reads a row back via the typed schema",
    async () => {
      const connectionString = await createTempDatabase();
      const db = connect(connectionString);

      const [company] = await db
        .insert(companies)
        .values({ name: "Test Company" })
        .returning({ id: companies.id });
      const [agent] = await db
        .insert(agents)
        .values({ companyId: company!.id, name: "ssh-test-agent" })
        .returning({ id: agents.id });

      const [inserted] = await db
        .insert(agentSshIdentities)
        .values({
          agentId: agent!.id,
          companyId: company!.id,
          publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterial agent@example",
          fingerprint: "SHA256:examplefingerprint",
          algorithm: "ssh-ed25519",
          label: "primary",
        })
        .returning();

      expect(inserted).toMatchObject({
        agentId: agent!.id,
        companyId: company!.id,
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterial agent@example",
        fingerprint: "SHA256:examplefingerprint",
        algorithm: "ssh-ed25519",
        label: "primary",
        revokedAt: null,
      });
      expect(inserted!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(inserted!.createdAt).toBeInstanceOf(Date);

      const rows = await db
        .select()
        .from(agentSshIdentities)
        .where(eq(agentSshIdentities.id, inserted!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fingerprint).toBe("SHA256:examplefingerprint");
    },
    30_000,
  );

  it(
    "enforces unique (company_id, fingerprint)",
    async () => {
      const connectionString = await createTempDatabase();
      const db = connect(connectionString);

      const [company] = await db
        .insert(companies)
        .values({ name: "Test Company" })
        .returning({ id: companies.id });
      const [agent1] = await db
        .insert(agents)
        .values({ companyId: company!.id, name: "agent-1" })
        .returning({ id: agents.id });
      const [agent2] = await db
        .insert(agents)
        .values({ companyId: company!.id, name: "agent-2" })
        .returning({ id: agents.id });

      await db.insert(agentSshIdentities).values({
        agentId: agent1!.id,
        companyId: company!.id,
        publicKey: "ssh-ed25519 AAAA1",
        fingerprint: "SHA256:dup",
        algorithm: "ssh-ed25519",
      });

      await expect(
        db.insert(agentSshIdentities).values({
          agentId: agent2!.id,
          companyId: company!.id,
          publicKey: "ssh-ed25519 AAAA2",
          fingerprint: "SHA256:dup",
          algorithm: "ssh-ed25519",
        }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    "cascades on agent delete",
    async () => {
      const connectionString = await createTempDatabase();
      const db = connect(connectionString);

      const [company] = await db
        .insert(companies)
        .values({ name: "Test Company" })
        .returning({ id: companies.id });
      const [agent] = await db
        .insert(agents)
        .values({ companyId: company!.id, name: "cascade-agent" })
        .returning({ id: agents.id });

      await db.insert(agentSshIdentities).values({
        agentId: agent!.id,
        companyId: company!.id,
        publicKey: "ssh-ed25519 AAAACASCADE",
        fingerprint: "SHA256:cascade",
        algorithm: "ssh-ed25519",
      });

      await db.delete(agents).where(eq(agents.id, agent!.id));

      const rows = await db
        .select()
        .from(agentSshIdentities)
        .where(eq(agentSshIdentities.agentId, agent!.id));
      expect(rows).toHaveLength(0);
    },
    30_000,
  );
});
