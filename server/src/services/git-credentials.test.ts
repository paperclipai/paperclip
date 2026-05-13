import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase, createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { issueGitCredentials } from "./git-credentials.js";
import { clusterTenantPoliciesService } from "./cluster-tenant-policies.js";
import type { SecretService } from "./git-credentials.js";

let dbHandle: EmbeddedPostgresTestDatabase;
let db: Db;
let clusterId: string;
let companyId: string;

beforeAll(async () => {
  dbHandle = await startEmbeddedPostgresTestDatabase("paperclip-git-creds-");
  db = createDb(dbHandle.connectionString);
  const c = await db.execute(sql`
    INSERT INTO cluster_connections (label, kind, capabilities, created_by)
    VALUES ('seed-cluster', 'in-cluster', '{"cilium":false,"storageClass":"standard","architectures":["amd64"]}'::jsonb, 'sys')
    RETURNING id
  `);
  clusterId = (c[0] as { id: string }).id;
  const co = await db.execute(sql`INSERT INTO companies (name) VALUES ('Acme') RETURNING id`);
  companyId = (co[0] as { id: string }).id;
}, 60_000);
afterAll(async () => { await dbHandle?.cleanup(); });

function makeFakeSecretService(map: Map<string, string>): SecretService {
  return {
    async resolve(secretId: string, resolvedCompanyId: string) {
      if (resolvedCompanyId !== companyId) throw new Error(`wrong company: ${resolvedCompanyId}`);
      const v = map.get(secretId);
      if (!v) throw new Error(`secret not found: ${secretId}`);
      return v;
    },
  };
}

describe("issueGitCredentials", () => {
  it("returns not_configured when policy has no gitCredentialsSecretId", async () => {
    const r = await issueGitCredentials({
      db,
      secretService: makeFakeSecretService(new Map()),
      clusterTenantPolicies: clusterTenantPoliciesService(db),
    }, { companyId, clusterConnectionId: clusterId, repoUrl: "https://github.com/acme/repo.git" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_configured");
  });

  it("returns the decoded {username, password} when the secret resolves", async () => {
    const secretRows = await db.execute(sql`
      INSERT INTO company_secrets (company_id, key, name)
      VALUES (${companyId}, 'github-pat', 'github-pat')
      RETURNING id
    `);
    const secretId = (secretRows[0] as { id: string }).id;
    await clusterTenantPoliciesService(db).upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: secretId,
    });
    const fakeSecrets = makeFakeSecretService(new Map([
      [secretId, JSON.stringify({ username: "x-access-token", password: "ghp_test" })],
    ]));
    const r = await issueGitCredentials({
      db,
      secretService: fakeSecrets,
      clusterTenantPolicies: clusterTenantPoliciesService(db),
    }, { companyId, clusterConnectionId: clusterId, repoUrl: "https://github.com/acme/repo.git" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.username).toBe("x-access-token");
      expect(r.password).toBe("ghp_test");
      expect(typeof r.expiresAt).toBe("string");
      expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("returns internal_error when the secret material is not valid JSON", async () => {
    const secretRows = await db.execute(sql`
      INSERT INTO company_secrets (company_id, key, name)
      VALUES (${companyId}, 'broken-pat', 'broken-pat')
      RETURNING id
    `);
    const secretId = (secretRows[0] as { id: string }).id;
    await clusterTenantPoliciesService(db).upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: secretId,
    });
    const fakeSecrets = makeFakeSecretService(new Map([[secretId, "not-json-at-all"]]));
    const r = await issueGitCredentials({
      db,
      secretService: fakeSecrets,
      clusterTenantPolicies: clusterTenantPoliciesService(db),
    }, { companyId, clusterConnectionId: clusterId, repoUrl: "https://github.com/acme/repo.git" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("internal_error");
  });

  it("returns internal_error when JSON lacks string username/password", async () => {
    const secretRows = await db.execute(sql`
      INSERT INTO company_secrets (company_id, key, name)
      VALUES (${companyId}, 'shape-bad-pat', 'shape-bad-pat')
      RETURNING id
    `);
    const secretId = (secretRows[0] as { id: string }).id;
    await clusterTenantPoliciesService(db).upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: secretId,
    });
    const fakeSecrets = makeFakeSecretService(new Map([
      [secretId, JSON.stringify({ username: 1234, password: null })],
    ]));
    const r = await issueGitCredentials({
      db,
      secretService: fakeSecrets,
      clusterTenantPolicies: clusterTenantPoliciesService(db),
    }, { companyId, clusterConnectionId: clusterId, repoUrl: "https://github.com/acme/repo.git" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("internal_error");
  });
});
