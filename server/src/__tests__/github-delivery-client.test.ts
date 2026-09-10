import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  toolApplications,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createGitHubDeliveryClient } from "../services/delivery/github-client.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function githubRepositoryResponse(): Response {
  return new Response(JSON.stringify({
    id: 42,
    name: "widget",
    full_name: "acme/widget",
    owner: { login: "acme" },
    default_branch: "main",
    private: true,
    archived: false,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describeEmbeddedPostgres("GitHub delivery connection credentials", () => {
  let db!: Db;
  let stopDb: (() => Promise<void>) | undefined;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-github-delivery-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("github-delivery-client");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function createPersonalPatFixture() {
    const [company] = await db.insert(companies).values({
      name: `GitHub delivery ${randomUUID()}`,
      issuePrefix: `GH${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const ownerUserId = `owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "member",
      status: "active",
    });

    const secrets = secretService(db);
    const definition = await secrets.createUserSecretDefinition(company!.id, {
      key: `github-delivery-${randomUUID()}`,
      name: "GitHub delivery token",
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
    });
    const token = `github-delivery-token-${randomUUID()}`;
    const personalSecret = await secrets.createCurrentUserSecretValue(
      company!.id,
      ownerUserId,
      { definitionId: definition!.id, value: token },
      { userId: ownerUserId },
    );
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id,
      applicationId: application!.id,
      name: "GitHub personal PAT",
      uid: `github/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "api_key",
      credentialSource: "paperclip_vault",
      credentialPolicy: "per_user",
      config: { sourceTemplateKey: "github" },
      transportConfig: {},
      credentialRefs: [{
        name: "credentials.authorization",
        secretId: personalSecret!.id,
        version: "latest",
        placement: "header",
        key: "Authorization",
        prefix: "Bearer ",
      }],
      credentialSecretRefs: [],
      status: "active",
      enabled: true,
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId: company!.id,
      connectionId: connection!.id,
      kind: "user",
      subjectUserId: ownerUserId,
      credentialSecretRefs: [{
        secretId: personalSecret!.id,
        versionSelector: "latest",
        configPath: "credentials.authorization",
        required: true,
        label: "GitHub token",
      }],
      status: "active",
      isDefault: false,
      createdByUserId: ownerUserId,
    }).returning();
    await secrets.syncUserSecretDeclarationsForTarget(
      company!.id,
      { targetType: "tool_connection", targetId: connection!.id },
      [{
        definitionKey: definition!.key,
        configPath: "credentials.authorization",
        envKey: "GITHUB_TOKEN",
        versionSelector: "latest",
        required: true,
        label: "GitHub token",
      }],
    );

    return {
      company: company!,
      connection: connection!,
      definition: definition!,
      grant: grant!,
      ownerUserId,
      personalSecret: personalSecret!,
      token,
    };
  }

  it("projects the personal PAT Authorization binding into a real delivery request", async () => {
    const fixture = await createPersonalPatFixture();
    const fetchMock = vi.fn(async () => githubRepositoryResponse());
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock as typeof fetch });

    const result = await client.getRepository(
      fixture.company.id,
      fixture.connection.id,
      "github.com",
      "acme",
      "widget",
    );

    expect(result).toMatchObject({
      ok: true,
      value: { id: "42", owner: "acme", name: "widget", fullName: "acme/widget" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widget",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${fixture.token}` }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(fixture.token);
  });

  it("fails closed for disabled, revoked, cross-company, and host-mismatched connections", async () => {
    const fixture = await createPersonalPatFixture();
    const fetchMock = vi.fn(async () => githubRepositoryResponse());
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock as typeof fetch });
    const requestRepository = (companyId = fixture.company.id, host = "github.com") => client.getRepository(
      companyId,
      fixture.connection.id,
      host,
      "acme",
      "widget",
    );

    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, fixture.connection.id));
    await expect(requestRepository()).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });

    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, fixture.connection.id));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, fixture.grant.id));
    await expect(requestRepository()).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });

    await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, fixture.grant.id));
    await expect(requestRepository(randomUUID())).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });
    await expect(requestRepository(fixture.company.id, "github.enterprise.test")).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a grant whose personal secret belongs to a different identity", async () => {
    const fixture = await createPersonalPatFixture();
    const intruderUserId = `intruder-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: fixture.company.id,
      principalType: "user",
      principalId: intruderUserId,
      membershipRole: "member",
      status: "active",
    });
    await secretService(db).createCurrentUserSecretValue(
      fixture.company.id,
      intruderUserId,
      { definitionId: fixture.definition.id, value: `intruder-token-${randomUUID()}` },
      { userId: intruderUserId },
    );
    await db.update(connectionGrants).set({ subjectUserId: intruderUserId }).where(eq(connectionGrants.id, fixture.grant.id));
    const fetchMock = vi.fn(async () => githubRepositoryResponse());
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock as typeof fetch });

    await expect(client.getRepository(
      fixture.company.id,
      fixture.connection.id,
      "github.com",
      "acme",
      "widget",
    )).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects ambiguous active personal grants rather than choosing an owner", async () => {
    const fixture = await createPersonalPatFixture();
    const secondOwnerUserId = `owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: fixture.company.id,
      principalType: "user",
      principalId: secondOwnerUserId,
      membershipRole: "member",
      status: "active",
    });
    const secondSecret = await secretService(db).createCurrentUserSecretValue(
      fixture.company.id,
      secondOwnerUserId,
      { definitionId: fixture.definition.id, value: `second-owner-token-${randomUUID()}` },
      { userId: secondOwnerUserId },
    );
    await db.insert(connectionGrants).values({
      companyId: fixture.company.id,
      connectionId: fixture.connection.id,
      kind: "user",
      subjectUserId: secondOwnerUserId,
      credentialSecretRefs: [{
        secretId: secondSecret!.id,
        versionSelector: "latest",
        configPath: "credentials.authorization",
        required: true,
        label: "GitHub token",
      }],
      status: "active",
      isDefault: false,
      createdByUserId: secondOwnerUserId,
    });
    const fetchMock = vi.fn(async () => githubRepositoryResponse());
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock as typeof fetch });

    await expect(client.getRepository(
      fixture.company.id,
      fixture.connection.id,
      "github.com",
      "acme",
      "widget",
    )).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
