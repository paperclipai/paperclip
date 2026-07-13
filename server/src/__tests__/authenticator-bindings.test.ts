import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyAuthenticatorAgents,
  companyAuthenticators,
  companySecretBindings,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { replaceAgentBindings } from "../routes/authenticators.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("authenticator agent bindings", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("authenticator-bindings");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(companyAuthenticatorAgents);
    await db.delete(companySecretBindings);
    await db.delete(companyAuthenticators);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  it("keeps authenticator ACL and secret bindings synchronized across bind, rebind, and unbind", async () => {
    const companyId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();
    const secretId = randomUUID();
    const authenticatorId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Authenticator test company",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values([
      { id: firstAgentId, companyId, name: "First", role: "engineer", adapterType: "codex_local", adapterConfig: {} },
      { id: secondAgentId, companyId, name: "Second", role: "qa", adapterType: "codex_local", adapterConfig: {} },
    ]);
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      name: "test-authenticator-secret",
      key: "test_authenticator_secret",
      provider: "local_encrypted",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [record] = await db.insert(companyAuthenticators).values({
      id: authenticatorId,
      companyId,
      name: "Test authenticator",
      secretId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    await replaceAgentBindings(db, record!, [firstAgentId, secondAgentId]);
    let acl = await db.select().from(companyAuthenticatorAgents).where(eq(companyAuthenticatorAgents.authenticatorId, authenticatorId));
    let secretBindings = await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.secretId, secretId),
      eq(companySecretBindings.configPath, `authenticators.${authenticatorId}.code`),
    ));
    expect(acl.map((row) => row.agentId).sort()).toEqual([firstAgentId, secondAgentId].sort());
    expect(secretBindings.map((row) => row.targetId).sort()).toEqual([firstAgentId, secondAgentId].sort());

    await replaceAgentBindings(db, record!, [secondAgentId]);
    acl = await db.select().from(companyAuthenticatorAgents).where(eq(companyAuthenticatorAgents.authenticatorId, authenticatorId));
    secretBindings = await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.secretId, secretId),
      eq(companySecretBindings.configPath, `authenticators.${authenticatorId}.code`),
    ));
    expect(acl.map((row) => row.agentId)).toEqual([secondAgentId]);
    expect(secretBindings.map((row) => row.targetId)).toEqual([secondAgentId]);

    await replaceAgentBindings(db, record!, []);
    expect(await db.select().from(companyAuthenticatorAgents).where(eq(companyAuthenticatorAgents.authenticatorId, authenticatorId))).toEqual([]);
    expect(await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.secretId, secretId),
      eq(companySecretBindings.configPath, `authenticators.${authenticatorId}.code`),
    ))).toEqual([]);
  });
});
