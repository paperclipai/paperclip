/**
 * Tier 2 integration tests for secretService.listPluginOwned().
 *
 * Uses embedded PostgreSQL with real schema migrations applied.
 * Verifies that the `createdByUserId LIKE 'plugin:%'` filter correctly
 * separates plugin-owned secrets from user/agent/system-created secrets.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySecrets, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

// A stable 32-byte hex master key for the local_encrypted provider in tests.
const TEST_MASTER_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeWithDb = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Embedded Postgres not detected — plugin secrets integration suite will not run: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeWithDb("secretService.listPluginOwned() — Tier 2 integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let prevMasterKey: string | undefined;

  beforeAll(async () => {
    // Set master key so local_encrypted provider can encrypt/decrypt.
    prevMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = TEST_MASTER_KEY;

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secrets-integration-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    if (prevMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = prevMasterKey;
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Integration Test Co",
      issuePrefix: `IT${id.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("returns empty array when no plugin secrets exist", async () => {
    const cid = await seedCompany();
    const svc = secretService(db);
    await svc.create(
      cid,
      { name: "USER_SECRET", provider: "local_encrypted", value: "user_value" },
      { userId: "user-board-123", agentId: null },
    );
    const rows = await svc.listPluginOwned();
    expect(rows).toHaveLength(0);
  });

  it("returns plugin-owned secrets and excludes user and system secrets", async () => {
    const cid = await seedCompany();
    const svc = secretService(db);

    const pluginActorId = "plugin:com.example.gitea";
    const pluginSecret = await svc.create(
      cid,
      { name: "GITHUB_TOKEN", provider: "local_encrypted", value: "ghp_test_value" },
      { userId: pluginActorId, agentId: null },
    );

    await svc.create(
      cid,
      { name: "USER_SECRET", provider: "local_encrypted", value: "user_value" },
      { userId: "user-board-123", agentId: null },
    );

    await svc.create(
      cid,
      { name: "SYSTEM_SECRET", provider: "local_encrypted", value: "system_value" },
    );

    const rows = await svc.listPluginOwned();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("GITHUB_TOKEN");
    expect(rows[0].createdByUserId).toBe(pluginActorId);
    expect(rows[0].id).toBe(pluginSecret.id);
  });

  it("returns secrets from multiple plugins across companies", async () => {
    const cid1 = await seedCompany();
    const cid2 = await seedCompany();
    const svc = secretService(db);

    await svc.create(
      cid1,
      { name: "GITEA_TOKEN", provider: "local_encrypted", value: "tok1" },
      { userId: "plugin:com.example.gitea", agentId: null },
    );
    await svc.create(
      cid2,
      { name: "SLACK_TOKEN", provider: "local_encrypted", value: "tok2" },
      { userId: "plugin:com.example.slack", agentId: null },
    );

    const rows = await svc.listPluginOwned();
    expect(rows).toHaveLength(2);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["GITEA_TOKEN", "SLACK_TOKEN"]);
    expect(rows.every((r) => r.createdByUserId?.startsWith("plugin:"))).toBe(true);
  });

  it("orders results by createdAt descending", async () => {
    const cid = await seedCompany();
    const svc = secretService(db);

    const first = await svc.create(
      cid,
      { name: "FIRST_TOKEN", provider: "local_encrypted", value: "v1" },
      { userId: "plugin:com.example.first", agentId: null },
    );
    const second = await svc.create(
      cid,
      { name: "SECOND_TOKEN", provider: "local_encrypted", value: "v2" },
      { userId: "plugin:com.example.second", agentId: null },
    );

    const rows = await svc.listPluginOwned();
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(second.id);
    expect(rows[1].id).toBe(first.id);
  });
});
