import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companySecrets, createDb, userSecretDefinitions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveGitHubApiCredential } from "../services/git-credentials.js";
import { secretService } from "../services/secrets.js";

const support = await getEmbeddedPostgresTestSupport();
const postgresDescribe = support.supported ? describe : describe.skip;
postgresDescribe("GitHub API company-secret lookup with PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    keyDir = await mkdtemp(path.join(os.tmpdir(), "github-api-credential-test-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(keyDir, "master.key");
    database = await startEmbeddedPostgresTestDatabase("github-api-credential-test-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => {
    await database?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Credential test", issuePrefix: `C${id.slice(0, 7)}` });
    return id;
  }
  it("limits candidates to requested live company secrets in the selected company", async () => {
    const companyId = await company();
    const otherCompanyId = await company();
    const definitionId = randomUUID();
    await db.insert(userSecretDefinitions).values({ id: definitionId, companyId, key: "personal", name: "Personal" });
    await db.insert(companySecrets).values([
      { companyId, name: "GH_TOKEN", key: "live" },
      { companyId, name: "GITHUB_TOKEN", key: "deleted", status: "deleted", deletedAt: new Date() },
      { companyId, name: "GITHUB_TOKEN", key: "personal", scope: "user", ownerUserId: "user-1", userSecretDefinitionId: definitionId },
      { companyId: otherCompanyId, name: "GITHUB_TOKEN", key: "foreign" },
      { companyId, name: "UNRELATED", key: "unrelated" },
    ]);
    const svc = secretService(db);
    expect((await svc.getByNames(companyId, ["GH_TOKEN", "GITHUB_TOKEN"])).map((row) => row.key)).toEqual(["live"]);
    expect(await svc.getByNames(companyId, [])).toEqual([]);
  });
  it("observes creation, rotation, and disablement between calls without caching credentials", async () => {
    const companyId = await company();
    const resolve = () => resolveGitHubApiCredential(db, companyId, { env: {} });
    expect(await resolve()).toBeNull();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: "GH_TOKEN", provider: "local_encrypted", value: "first-token" });
    expect(await resolve()).toEqual({ token: "first-token", source: "company_secret", secretName: "GH_TOKEN" });
    await svc.rotate(secret.id, { value: "second-token" });
    expect(await resolve()).toEqual({ token: "second-token", source: "company_secret", secretName: "GH_TOKEN" });
    await svc.update(secret.id, { status: "disabled" });
    expect(await resolve()).toBeNull();
  });
});
