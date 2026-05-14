import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase, createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { clusterConnectionsService } from "./cluster-connections.js";

let dbHandle: EmbeddedPostgresTestDatabase;
let db: Db;

beforeAll(async () => {
  dbHandle = await startEmbeddedPostgresTestDatabase("paperclip-cluster-conn-test-");
  db = createDb(dbHandle.connectionString);
}, 60_000);
afterAll(async () => { await dbHandle?.cleanup(); });

describe("clusterConnectionsService", () => {
  it("creates, lists, gets, resolves, and deletes a connection", async () => {
    const svc = clusterConnectionsService(db, {
      resolveSecret: async (ref) => `fake-kubeconfig-yaml:${ref.provider}:${ref.name}`,
    });
    const created = await svc.create({
      label: "kind-test",
      kind: "kubeconfig",
      kubeconfigSecretRef: { provider: "local_encrypted", name: "kind-cfg" },
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "system",
    });
    expect(created.id).toBeDefined();
    expect(created.defaultNamespacePrefix).toBe("paperclip-");
    expect(created.allowAgentImageOverride).toBe(false);

    const list = await svc.list();
    expect(list).toHaveLength(1);

    const fetched = await svc.get(created.id);
    expect(fetched?.label).toBe("kind-test");

    const resolved = await svc.resolve(created.id);
    expect(resolved?.kubeconfigYaml).toBe("fake-kubeconfig-yaml:local_encrypted:kind-cfg");

    await svc.delete(created.id);
    expect(await svc.list()).toHaveLength(0);
  });

  it("rejects duplicate labels", async () => {
    const svc = clusterConnectionsService(db, { resolveSecret: async () => "x" });
    await svc.create({
      label: "dupe", kind: "in-cluster",
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "system",
    });
    await expect(svc.create({
      label: "dupe", kind: "in-cluster",
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "system",
    })).rejects.toThrow(/label/i);
  });

  it("resolve() returns null for an unknown id", async () => {
    const svc = clusterConnectionsService(db, { resolveSecret: async () => "x" });
    expect(await svc.resolve("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("resolve() omits kubeconfigYaml for in-cluster connections", async () => {
    const svc = clusterConnectionsService(db, {
      resolveSecret: async () => { throw new Error("should not be called for in-cluster"); },
    });
    const created = await svc.create({
      label: "in-cluster-test", kind: "in-cluster",
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "system",
    });
    const resolved = await svc.resolve(created.id);
    expect(resolved?.kind).toBe("in-cluster");
    expect(resolved?.kubeconfigYaml).toBeUndefined();
  });
});
