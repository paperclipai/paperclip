import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  userSecretDefinitions,
} from "@paperclipai/db";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));

import { aiConnectionService } from "../services/ai-connections.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping connection sign-in secret tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secretService user secrets that hold a connection's sign-in", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-connection-sign-in-secret-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-sign-in-secret-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function connectClaude() {
    const [company] = await db.insert(companies).values({
      name: `Sign-in secret ${randomUUID()}`,
      issuePrefix: `SS${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const userId = `sign-in-owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    const account = await aiConnectionService(db).save(companyId, userId, {
      provider: "anthropic", method: "subscription", ownership: "personal", name: "My Claude subscription",
      loginSessionId: "fixture", agentIds: [], allAgents: true,
    }, "fixture-subscription-token");
    const [definition] = await db.select().from(userSecretDefinitions).where(and(
      eq(userSecretDefinitions.companyId, companyId),
      eq(userSecretDefinitions.key, `ai_${account.grantId.replaceAll("-", "_")}`),
    ));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    return { companyId, userId, account, definitionId: definition!.id, secretId: grant!.credentialSecretRefs[0]!.secretId };
  }

  async function secretStatus(secretId: string) {
    const [secret] = await db.select({ status: companySecrets.status }).from(companySecrets).where(eq(companySecrets.id, secretId));
    return secret?.status;
  }

  it("refuses to delete the secret while the account is connected and names the account", async () => {
    const { companyId, userId, definitionId, secretId } = await connectClaude();
    const svc = secretService(db);

    const refusal = svc.removeUserSecretDefinition(companyId, definitionId, { userId });
    await expect(refusal).rejects.toMatchObject({ status: 409, details: { code: "secret_used_by_connection" } });
    await expect(refusal).rejects.toThrow(
      'This secret is the saved sign-in for "My Claude subscription". Disconnect that account instead of deleting its secret.',
    );
    await expect(svc.updateUserSecretDefinition(companyId, definitionId, { status: "deleted" }, { userId }))
      .rejects.toMatchObject({ status: 409 });

    expect(await secretStatus(secretId)).toBe("active");
    const [definition] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, definitionId));
    expect(definition).toMatchObject({ status: "active", deletedAt: null });
  });

  it("refuses to disable the secret while the account is connected", async () => {
    const { companyId, userId, definitionId } = await connectClaude();
    const svc = secretService(db);

    await expect(svc.updateUserSecretDefinition(companyId, definitionId, { status: "disabled" }, { userId }))
      .rejects.toThrow('Disconnect that account instead of disabling its secret.');

    const [definition] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, definitionId));
    expect(definition?.status).toBe("active");
    await expect(svc.updateUserSecretDefinition(companyId, definitionId, { name: "Renamed sign-in" }, { userId }))
      .resolves.toMatchObject({ name: "Renamed sign-in", status: "active" });
  });

  it("refuses to delete or disable the owner's saved value from My secrets", async () => {
    const { companyId, userId, secretId } = await connectClaude();
    const svc = secretService(db);

    await expect(svc.removeCurrentUserSecretValue(companyId, userId, secretId))
      .rejects.toMatchObject({ status: 409, details: { code: "secret_used_by_connection" } });
    await expect(svc.updateCurrentUserSecretValue(companyId, userId, secretId, { status: "deleted" }, { userId }))
      .rejects.toThrow("instead of deleting its secret");
    await expect(svc.updateCurrentUserSecretValue(companyId, userId, secretId, { status: "disabled" }, { userId }))
      .rejects.toThrow("instead of disabling its secret");

    expect(await secretStatus(secretId)).toBe("active");
    await expect(svc.updateCurrentUserSecretValue(companyId, userId, secretId, { status: "active" }, { userId }))
      .resolves.toMatchObject({ id: secretId, status: "active" });
  });

  it("checks inside the reconnect lock, so a reconnect that lands first keeps its sign-in", async () => {
    const { companyId, userId, account, definitionId, secretId } = await connectClaude();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
    let release!: () => void;
    let held!: () => void;
    const lockHeld = new Promise<void>((resolve) => { held = resolve; });
    const reconnect = withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      held();
      await new Promise<void>((resolve) => { release = resolve; });
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, account.grantId));
    });
    await lockHeld;

    const removal = secretService(db).removeUserSecretDefinition(companyId, definitionId, { userId });
    const settled = removal.then(() => "removed", () => "refused");
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await reconnect;

    expect(await settled).toBe("refused");
    await expect(removal).rejects.toMatchObject({ status: 409 });
    expect(await secretStatus(secretId)).toBe("active");
  });

  it("deletes the secret once the account is disconnected", async () => {
    const { companyId, userId, account, definitionId } = await connectClaude();
    await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });

    const removed = await secretService(db).removeUserSecretDefinition(companyId, definitionId, { userId });

    expect(removed).toMatchObject({ id: definitionId, status: "deleted" });
  });
});
