import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  createDb,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { clusterNamespaceBindingsService } from "./cluster-namespace-bindings.js";

let dbHandle: EmbeddedPostgresTestDatabase;
let db: Db;
let clusterId: string;
let companyId: string;

beforeAll(async () => {
  dbHandle = await startEmbeddedPostgresTestDatabase("paperclip-ns-binding-test-");
  db = createDb(dbHandle.connectionString);

  // Seed a cluster connection
  const clusterRows = await db.execute(sql`
    INSERT INTO cluster_connections (label, kind, capabilities, created_by)
    VALUES ('seed-cluster', 'in-cluster', '{"cilium":false,"storageClass":"standard","architectures":["amd64"]}'::jsonb, 'sys')
    RETURNING id
  `);
  clusterId = (clusterRows[0] as { id: string }).id;

  // Seed a company
  const companyRows = await db.execute(sql`
    INSERT INTO companies (name)
    VALUES ('Acme')
    RETURNING id
  `);
  companyId = (companyRows[0] as { id: string }).id;
});

afterAll(async () => {
  await dbHandle.cleanup();
});

describe("clusterNamespaceBindingsService", () => {
  it("getByClusterAndCompany() returns null when no binding exists", async () => {
    const svc = clusterNamespaceBindingsService(db);
    const result = await svc.getByClusterAndCompany(clusterId, companyId);
    expect(result).toBeNull();
  });

  it("record() creates a new binding", async () => {
    const svc = clusterNamespaceBindingsService(db);
    await svc.record({
      clusterConnectionId: clusterId,
      companyId,
      namespaceName: "paperclip-acme",
    });

    const found = await svc.getByClusterAndCompany(clusterId, companyId);
    expect(found).not.toBeNull();
    expect(found?.namespaceName).toBe("paperclip-acme");
  });

  it("record() is idempotent — second call updates the namespace name", async () => {
    const svc = clusterNamespaceBindingsService(db);
    await svc.record({
      clusterConnectionId: clusterId,
      companyId,
      namespaceName: "paperclip-acme-v2",
    });

    const found = await svc.getByClusterAndCompany(clusterId, companyId);
    expect(found?.namespaceName).toBe("paperclip-acme-v2");
  });

  it("record() handles concurrent first-write without violating the unique constraint", async () => {
    // Seed an isolated company so this test does not interact with the rows
    // written by the earlier suite cases.
    const conRows = await db.execute(sql`
      INSERT INTO companies (name, issue_prefix)
      VALUES ('Gamma Corp', 'GAM')
      RETURNING id
    `);
    const conCompanyId = (conRows[0] as { id: string }).id;

    const svc = clusterNamespaceBindingsService(db);
    const N = 8;
    // The pre-fix select-then-insert shape lost this race: two callers would
    // both observe no row and one would hit the unique constraint as an
    // unhandled error. With ON CONFLICT the upsert is unconditionally atomic.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        svc.record({
          clusterConnectionId: clusterId,
          companyId: conCompanyId,
          namespaceName: `paperclip-gamma-${i}`,
        }),
      ),
    );

    const found = await svc.getByClusterAndCompany(clusterId, conCompanyId);
    expect(found).not.toBeNull();
    // The winning name is whichever upsert committed last; we only need to
    // assert that exactly one row exists and no exceptions were thrown.
    expect(found?.namespaceName).toMatch(/^paperclip-gamma-\d$/);
  });

  it("record() preserves other rows when called for a different company", async () => {
    const svc = clusterNamespaceBindingsService(db);

    // Seed a second company
    const otherRows = await db.execute(sql`
      INSERT INTO companies (name, issue_prefix)
      VALUES ('Beta Corp', 'BET')
      RETURNING id
    `);
    const otherCompanyId = (otherRows[0] as { id: string }).id;

    await svc.record({
      clusterConnectionId: clusterId,
      companyId: otherCompanyId,
      namespaceName: "paperclip-beta-corp",
    });

    // Original binding should still be paperclip-acme-v2
    const acme = await svc.getByClusterAndCompany(clusterId, companyId);
    expect(acme?.namespaceName).toBe("paperclip-acme-v2");

    // New binding should be paperclip-beta-corp
    const beta = await svc.getByClusterAndCompany(clusterId, otherCompanyId);
    expect(beta?.namespaceName).toBe("paperclip-beta-corp");
  });
});
