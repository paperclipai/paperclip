import { randomUUID } from "node:crypto";
import { companies, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import type { StorageService } from "../src/storage/types.js";
import { createApp } from "../src/app.js";

async function main(): Promise<void> {
  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dev-watch-issue-create-");
  const db = createDb(tempDb.connectionString);
  const companyId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  const storageService: StorageService = {
    provider: "local_disk",
    async putFile() {
      throw new Error("dev-watch issue-create smoke should not upload files");
    },
    async getObject() {
      throw new Error("dev-watch issue-create smoke should not fetch objects");
    },
    async headObject() {
      return { exists: false };
    },
    async deleteObject() {},
  };

  try {
    await db.insert(companies).values({
      id: companyId,
      name: "Dev Watch Smoke",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const app = await createApp(db, {
      uiMode: "none",
      serverPort: 3100,
      storageService,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
    });

    const request = await import("supertest");
    const response = await request.default(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Dev watch create smoke",
        closeContract: {
          evidenceTarget: 1,
          evidencePath: "TSMC-18567",
        },
      });

    if (response.status !== 201) {
      throw new Error(`Issue create smoke failed with ${response.status}: ${JSON.stringify(response.body)}`);
    }

    if (response.body?.closeContract?.evidenceTarget !== 1 || response.body?.closeContract?.evidencePath !== "TSMC-18567") {
      throw new Error(`Issue create smoke returned unexpected closeContract: ${JSON.stringify(response.body?.closeContract)}`);
    }

    process.stdout.write(
      `[dev-watch-smoke] issue create OK (${response.body.identifier ?? response.body.id}) with closeContract persisted\n`,
    );
  } finally {
    await tempDb.cleanup();
  }
}

await main();
process.exit(0);
