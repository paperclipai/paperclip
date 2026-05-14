import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase, createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { clusterTenantPoliciesService } from "./cluster-tenant-policies.js";

let dbHandle: EmbeddedPostgresTestDatabase;
let db: Db;
let clusterId: string;
let companyId: string;

beforeAll(async () => {
  dbHandle = await startEmbeddedPostgresTestDatabase("paperclip-tenant-pol-test-");
  db = createDb(dbHandle.connectionString);

  // Seed a cluster connection and a company.
  const clusterRows = await db.execute(sql`
    INSERT INTO cluster_connections (label, kind, capabilities, created_by)
    VALUES ('seed-cluster', 'in-cluster', '{"cilium":false,"storageClass":"standard","architectures":["amd64"]}'::jsonb, 'sys')
    RETURNING id
  `);
  clusterId = (clusterRows[0] as { id: string }).id;

  // companies has: id (uuid, defaultRandom), name (text notNull), and everything else defaults.
  const companyRows = await db.execute(sql`
    INSERT INTO companies (name)
    VALUES ('Acme')
    RETURNING id
  `);
  companyId = (companyRows[0] as { id: string }).id;
}, 60_000);
afterAll(async () => { await dbHandle?.cleanup(); });

describe("clusterTenantPoliciesService", () => {
  it("get() returns null when no policy exists", async () => {
    const svc = clusterTenantPoliciesService(db);
    const result = await svc.get(clusterId, companyId);
    expect(result).toBeNull();
  });

  it("upsert() creates a row, then a second upsert updates it", async () => {
    const svc = clusterTenantPoliciesService(db);
    const created = await svc.upsert({
      clusterConnectionId: clusterId,
      companyId,
      quota: { requestsCpu: "32" },
      limitRange: null,
      additionalAllowFqdns: ["api.acme.io"],
      imageOverrides: null,
    });
    expect(created.quota?.requestsCpu).toBe("32");
    expect(created.additionalAllowFqdns).toEqual(["api.acme.io"]);

    const updated = await svc.upsert({
      clusterConnectionId: clusterId,
      companyId,
      quota: { requestsCpu: "64", countJobs: 200 },
      limitRange: { default: { cpu: "2" } },
      additionalAllowFqdns: ["api.acme.io", "*.linear.app"],
      imageOverrides: { claude_local: "ecr.acme.io/agent-runtime-claude:v1" },
    });
    expect(updated.quota?.requestsCpu).toBe("64");
    expect(updated.quota?.countJobs).toBe(200);
    expect(updated.additionalAllowFqdns).toEqual(["api.acme.io", "*.linear.app"]);
    expect(updated.imageOverrides?.claude_local).toBe("ecr.acme.io/agent-runtime-claude:v1");
  });

  it("get() reads back what upsert wrote", async () => {
    const svc = clusterTenantPoliciesService(db);
    const fetched = await svc.get(clusterId, companyId);
    expect(fetched).not.toBeNull();
    expect(fetched?.additionalAllowFqdns).toEqual(["api.acme.io", "*.linear.app"]);
    expect(fetched?.limitRange?.default?.cpu).toBe("2");
  });

  it("upsert() handles concurrent first-write without a unique-constraint error", async () => {
    // Seed an isolated company so this case doesn't interact with rows
    // written by earlier suite cases.
    const conRows = await db.execute(sql`
      INSERT INTO companies (name, issue_prefix) VALUES ('Delta Corp', 'DLT') RETURNING id
    `);
    const conCompanyId = (conRows[0] as { id: string }).id;
    const svc = clusterTenantPoliciesService(db);
    const N = 8;
    // Pre-fix shape lost this race: two callers both observed existing=null
    // and both attempted INSERT, with the loser surfacing a unique-constraint
    // error from cluster_tenant_policies_cluster_company_uq. The atomic
    // ON CONFLICT shape eliminates that error path.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        svc.upsert({
          clusterConnectionId: clusterId,
          companyId: conCompanyId,
          quota: { requestsCpu: `${i}` },
          limitRange: null,
          additionalAllowFqdns: [],
          imageOverrides: null,
        }),
      ),
    );
    const found = await svc.get(clusterId, conCompanyId);
    expect(found).not.toBeNull();
    expect(found?.quota?.requestsCpu).toMatch(/^\d$/);
  });

  it("upsert() preserves httpProxyUrl when the caller doesn't pass one", async () => {
    const svc = clusterTenantPoliciesService(db);
    // Set a proxy URL via an explicit upsert.
    await svc.upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: [], imageOverrides: null,
      httpProxyUrl: "http://proxy.acme.internal:3128",
    });
    expect((await svc.get(clusterId, companyId))?.httpProxyUrl).toBe("http://proxy.acme.internal:3128");

    // Subsequent upsert without httpProxyUrl must NOT clear it.
    await svc.upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: ["api.example.com"], imageOverrides: null,
    });
    expect((await svc.get(clusterId, companyId))?.httpProxyUrl).toBe("http://proxy.acme.internal:3128");

    // Explicit null clears it.
    await svc.upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: [], imageOverrides: null,
      httpProxyUrl: null,
    });
    expect((await svc.get(clusterId, companyId))?.httpProxyUrl).toBeNull();
  });
});
