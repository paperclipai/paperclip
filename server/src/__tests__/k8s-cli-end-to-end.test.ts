/**
 * M1 End-to-End smoke — CLI services against a real kind cluster
 *
 * Exercises the EXACT code path the CLI uses:
 *   clusterConnectionsService.create  (paperclipai cluster add …)
 *   → createExecutionTargetRegistry / registerKubernetesExecutionTargetDriver
 *   → driver.ensureTenant            (provisions namespace on kind)
 *   → clusterNamespaceBindingsService.record
 *
 * Run with:
 *   pnpm -w exec vitest run --config server/vitest.integration.config.ts k8s-cli-end-to-end
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  companies,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type Db,
} from "@paperclipai/db";
import { clusterConnectionsService } from "../services/cluster-connections.js";
import { clusterTenantPoliciesService } from "../services/cluster-tenant-policies.js";
import { clusterNamespaceBindingsService } from "../services/cluster-namespace-bindings.js";
import { createExecutionTargetRegistry } from "../adapters/execution-target-registry.js";
import { registerKubernetesExecutionTargetDriver } from "../adapters/execution-targets/kubernetes.js";
import { deriveNamespaceName } from "@paperclipai/execution-target-kubernetes";

// ---------------------------------------------------------------------------
// Inline kind harness (mirrors packages/adapters/kubernetes-execution/test/integration/_harness.ts)
// ---------------------------------------------------------------------------

interface KindCluster {
  name: string;
  kubeconfigPath: string;
  kubeconfigYaml: string;
  cleanup(): void;
}

function spinUpKind(): KindCluster {
  const name = `pp-e2e-${Math.random().toString(36).slice(2, 8)}`;
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const kubeconfigPath = join(dir, "kubeconfig");
  execSync(`kind create cluster --name ${name} --kubeconfig ${kubeconfigPath} --wait 90s`, {
    stdio: "inherit",
  });
  const kubeconfigYaml = readFileSync(kubeconfigPath, "utf-8");
  return {
    name,
    kubeconfigPath,
    kubeconfigYaml,
    cleanup: () => {
      try { execSync(`kind delete cluster --name ${name}`, { stdio: "ignore" }); } catch { /* swallow */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Suite-level setup
// ---------------------------------------------------------------------------

let kc: KindCluster;
let dbHandle: EmbeddedPostgresTestDatabase;
let db: Db;
let companyId: string;

beforeAll(async () => {
  // Spin up the kind cluster and embedded postgres in parallel.
  const [kindResult, dbResult] = await Promise.all([
    Promise.resolve(spinUpKind()),
    startEmbeddedPostgresTestDatabase("paperclip-m1-e2e-"),
  ]);
  kc = kindResult;
  dbHandle = dbResult;
  db = createDb(dbHandle.connectionString);

  // Seed a company row (required FK for namespace bindings).
  const [row] = await db.insert(companies).values({ name: "Acme Corp" }).returning();
  companyId = row.id;
}, 240_000);

afterAll(async () => {
  kc?.cleanup();
  await dbHandle?.cleanup();
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("M1 end-to-end smoke (CLI services + kind)", () => {
  it(
    "registers cluster, provisions a tenant, records binding, asserts idempotency",
    async () => {
      // 1. Wire services exactly the way the CLI does.
      const cs = clusterConnectionsService(db, {
        resolveSecret: async () => kc.kubeconfigYaml,
      });
      const tps = clusterTenantPoliciesService(db);
      const bindings = clusterNamespaceBindingsService(db);

      // 2. Register a cluster connection (paperclipai cluster add …).
      const conn = await cs.create({
        label: "smoke-kind",
        kind: "kubeconfig",
        kubeconfigSecretRef: { provider: "stub", name: "kc" },
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
        createdBy: "smoke",
      });
      expect(conn.id).toBeDefined();
      expect(conn.label).toBe("smoke-kind");

      // 3. Wire the registry exactly like the server does at startup.
      const reg = createExecutionTargetRegistry();
      registerKubernetesExecutionTargetDriver(reg, {
        resolveConnection: (id) => cs.resolve(id),
      });
      const driver = reg.get("kubernetes")!;
      expect(driver).not.toBeNull();

      // 4. Ensure the tenant namespace (provisions namespace on kind).
      const result = await driver.ensureTenant({
        clusterConnectionId: conn.id,
        company: { id: companyId, slug: "acme-corp" },
        tenantPolicy: null,
        driverServiceAccount: { name: "default", namespace: "default" },
        controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
        adapterAllowFqdns: [],
        imagePullDockerConfigJson: null,
      });
      const expectedNamespace = deriveNamespaceName({
        companySlug: "acme-corp",
        companyId,
        prefix: "paperclip-",
      });
      expect(result.namespace).toBe(expectedNamespace);
      expect(result.ciliumApplied).toBe(false);

      // 5. Record the namespace binding (what the CLI does after ensure-tenant).
      await bindings.record({
        clusterConnectionId: conn.id,
        companyId,
        namespaceName: result.namespace,
      });

      // 6. Verify by reading the binding back from DB.
      const binding = await bindings.getByClusterAndCompany(conn.id, companyId);
      expect(binding).not.toBeNull();
      expect(binding!.namespaceName).toBe(expectedNamespace);

      // 7. Verify the tenant policy get path returns null (no policy seeded).
      const tp = await tps.get(conn.id, companyId);
      expect(tp).toBeNull();

      // 8. Idempotency: re-running ensure-tenant must return the same namespace
      //    without error (namespace already exists on kind).
      const result2 = await driver.ensureTenant({
        clusterConnectionId: conn.id,
        company: { id: companyId, slug: "acme-corp" },
        tenantPolicy: null,
        driverServiceAccount: { name: "default", namespace: "default" },
        controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
        adapterAllowFqdns: [],
        imagePullDockerConfigJson: null,
      });
      expect(result2.namespace).toBe(result.namespace);

      // 9. Record the binding again; idempotent upsert should not throw.
      await bindings.record({
        clusterConnectionId: conn.id,
        companyId,
        namespaceName: result2.namespace,
      });
      const binding2 = await bindings.getByClusterAndCompany(conn.id, companyId);
      expect(binding2!.namespaceName).toBe(expectedNamespace);
    },
    240_000,
  );
});
