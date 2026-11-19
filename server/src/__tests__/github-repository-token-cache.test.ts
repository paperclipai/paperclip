import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  chatEndpoints,
  companies,
  companySecretBindings,
  createDb,
  secretAccessEvents,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import {
  githubBotRepositoryClient,
  githubBotRepositoryToken,
} from "../services/chat-github-client.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const HOUR = 60 * 60_000;

describeDatabase("GitHub repository token reuse", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-token-cache-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GitHub token reuse", issuePrefix: randomUUID().slice(0, 8).toUpperCase() });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "process" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "GitHub", type: "chat" });
    const secrets = secretService(db);
    const values = { appId: "1234", privateKey: privateKeyPem, installationId: "2468", webhookSecret: "webhook-secret" };
    const refs: ToolCredentialSecretRef[] = [];
    const secretIds: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const secret = await secrets.create(companyId, {
        name: `github.${key}.${randomUUID().slice(0, 8)}`,
        key: `CHAT_GITHUB_${key}_${randomUUID()}`.replaceAll("-", "_").toUpperCase(),
        provider: "local_encrypted",
        value,
      });
      secretIds[key] = secret.id;
      refs.push({ secretId: secret.id, versionSelector: "latest", configPath: `credentials.${key}`, required: true });
    }
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub", uid: connectionId,
      transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active", credentialSecretRefs: refs });
    await db.insert(companySecretBindings).values(refs.map(ref => ({ companyId, secretId: ref.secretId,
      targetType: "tool_connection", targetId: connectionId, configPath: ref.configPath })));
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "github",
      publicId: endpointId, assignedAgentId: agentId, status: "active" });

    const mints: Array<{ installationId: string; repositoryIds: number[]; permissions: unknown }> = [];
    const requests: Array<{ path: string; token: string }> = [];
    const rejected = new Set<string>();
    let expiresIn = HOUR;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      const mint = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (mint) {
        const body = JSON.parse(String(init?.body)) as { repository_ids: number[]; permissions: unknown };
        mints.push({ installationId: mint[1]!, repositoryIds: body.repository_ids, permissions: body.permissions });
        return Response.json({ token: `installation-token-${mints.length}`,
          expires_at: new Date(Date.now() + expiresIn).toISOString() }, { status: 201 });
      }
      requests.push({ path: url.pathname, token });
      if (rejected.has(token)) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return Response.json({ head: { sha: "abc" } });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const audits = async () => (await db.select({ configPath: secretAccessEvents.configPath }).from(secretAccessEvents)
      .where(and(eq(secretAccessEvents.companyId, companyId), eq(secretAccessEvents.consumerId, connectionId))))
      .map(row => row.configPath).sort();
    const token = (repositoryId = "101") => githubBotRepositoryToken(db, companyId, endpointId, repositoryId, fetchImpl);
    return { companyId, connectionId, endpointId, secretIds, mints, requests, rejected, fetchImpl, audits, token,
      setExpiresIn: (ms: number) => { expiresIn = ms; } };
  }

  it("mints once and resolves the App's secrets only when it mints", async () => {
    const f = await fixture();
    const first = await f.token();
    const second = await f.token();
    expect(second).toBe(first);
    expect(f.mints).toEqual([{ installationId: "2468", repositoryIds: [101],
      permissions: { contents: "read", metadata: "read", issues: "write", pull_requests: "write", checks: "write" } }]);
    // One audited read per mint credential; the webhook secret is never read to mint.
    expect(await f.audits()).toEqual(["credentials.appId", "credentials.installationId", "credentials.privateKey"]);
  });

  it("refreshes a token shortly before GitHub's expiry", async () => {
    const f = await fixture();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const first = await f.token();
    now.mockReturnValue(start + 54 * 60_000);
    expect(await f.token()).toBe(first);
    now.mockReturnValue(start + 56 * 60_000);
    const refreshed = await f.token();
    expect(refreshed).not.toBe(first);
    expect(f.mints).toHaveLength(2);
    expect(await f.token()).toBe(refreshed);
  });

  it("never keeps a token GitHub issues for less than the safety margin", async () => {
    const f = await fixture();
    f.setExpiresIn(2 * 60_000);
    await f.token();
    await f.token();
    expect(f.mints).toHaveLength(2);
  });

  it("mints again after a credential rotation and uses the new credential", async () => {
    const f = await fixture();
    const first = await f.token();
    await secretService(db).rotate(f.secretIds.installationId!, { value: "1357" });
    const rotated = await f.token();
    expect(rotated).not.toBe(first);
    expect(f.mints.map(mint => mint.installationId)).toEqual(["2468", "1357"]);
    expect(await f.token()).toBe(rotated);
    expect(f.mints).toHaveLength(2);
  });

  it("mints again after the connection's credential refs change", async () => {
    const f = await fixture();
    const first = await f.token();
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connectionId));
    // Same secrets under a pinned version: a different authority, so a different token.
    await db.update(toolConnections).set({ credentialSecretRefs: connection!.credentialSecretRefs
      .map(ref => ({ ...ref, versionSelector: 1 })) }).where(eq(toolConnections.id, f.connectionId));
    expect(await f.token()).not.toBe(first);
    expect(f.mints).toHaveLength(2);
  });

  it("never serves a cached token across a pause, revoke or disabled connection", async () => {
    const f = await fixture();
    const endpoint = eq(chatEndpoints.id, f.endpointId);
    const first = await f.token();

    await db.update(chatEndpoints).set({ status: "paused" }).where(endpoint);
    await expect(f.token()).rejects.toThrow("GitHub bot connection is unavailable");
    await db.update(chatEndpoints).set({ status: "active" }).where(endpoint);
    const afterPause = await f.token();
    expect(afterPause).not.toBe(first);

    // A pause and resume with no call in between still drops the token: pausing
    // advances the endpoint's runtime generation.
    await db.update(chatEndpoints).set({ status: "paused",
      setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', to_jsonb(coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::int, 0) + 1))` })
      .where(endpoint);
    await db.update(chatEndpoints).set({ status: "active" }).where(endpoint);
    const afterResume = await f.token();
    expect(afterResume).not.toBe(afterPause);

    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connectionId));
    await expect(f.token()).rejects.toThrow("GitHub bot connection is not active");
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, f.connectionId));
    const afterDisable = await f.token();
    expect(afterDisable).not.toBe(afterResume);

    await db.update(chatEndpoints).set({ status: "revoked" }).where(endpoint);
    await expect(f.token()).rejects.toThrow("GitHub bot connection is unavailable");
    expect(f.mints).toHaveLength(4);
  });

  it("mints a separate token for each repository", async () => {
    const f = await fixture();
    const first = await f.token("101");
    const second = await f.token("202");
    expect(second).not.toBe(first);
    expect(await f.token("101")).toBe(first);
    expect(await f.token("202")).toBe(second);
    expect(f.mints.map(mint => mint.repositoryIds)).toEqual([[101], [202]]);
  });

  it("replaces a cached token GitHub rejects and retries the request once", async () => {
    const f = await fixture();
    const cached = await f.token();
    f.rejected.add(cached);
    const request = await githubBotRepositoryClient(db, f.companyId, f.endpointId, "101", f.fetchImpl);
    await expect(request<{ head: { sha: string } }>("/repos/o/r/pulls/1")).resolves.toEqual({ head: { sha: "abc" } });
    expect(f.requests).toEqual([
      { path: "/repos/o/r/pulls/1", token: cached },
      { path: "/repos/o/r/pulls/1", token: "installation-token-2" },
    ]);
    // The replacement is the cached token from now on.
    expect(await f.token()).toBe("installation-token-2");
    expect(f.mints).toHaveLength(2);

    // A freshly minted token that GitHub rejects is not retried.
    const other = await fixture();
    other.rejected.add("installation-token-1");
    const fresh = await githubBotRepositoryClient(db, other.companyId, other.endpointId, "101", other.fetchImpl);
    await expect(fresh("/repos/o/r/pulls/1")).rejects.toMatchObject({ details: { providerStatus: 401 } });
    expect(other.requests).toHaveLength(1);
    expect(other.mints).toHaveLength(1);
  });
});
