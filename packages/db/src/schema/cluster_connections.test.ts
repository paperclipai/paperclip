import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../test-embedded-postgres.js";
import { createDb } from "../client.js";
import { clusterConnections } from "./cluster_connections.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cluster_connections schema tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cluster_connections schema", () => {
  let connectionString: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-cluster-connections-test-");
    connectionString = db.connectionString;
    cleanup = db.cleanup;
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it(
    "inserts and reads back a row with the expected shape",
    async () => {
      const db = createDb(connectionString);
      const [inserted] = await db.insert(clusterConnections).values({
        label: "test-cluster",
        kind: "in-cluster",
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
        createdBy: "system",
      }).returning();
      expect(inserted.id).toBeDefined();
      expect(inserted.defaultNamespacePrefix).toBe("paperclip-");
      expect(inserted.allowAgentImageOverride).toBe("false");
    },
    30_000,
  );
});
