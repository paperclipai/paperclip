import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secrets service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secretService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("secrets-service");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterAll(async () => {
    if (stopDb) await stopDb();
  });

  it("includes agent env reference summaries without exposing adapter config", async () => {
    const companyId = randomUUID();
    const referencedAgentId = randomUUID();
    const unreferencedAgentId = randomUUID();
    const svc = secretService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const secret = await svc.create(companyId, {
      name: "OPENAI_API_KEY",
      provider: "local_encrypted",
      value: "test-value",
      description: "Used by Codex",
    });

    await db.insert(agents).values([
      {
        id: referencedAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
            },
            SECOND_OPENAI_KEY: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
            },
            PLAIN_VALUE: {
              type: "plain",
              value: "visible",
            },
          },
        },
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: unreferencedAgentId,
        companyId,
        name: "NoSecrets",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {
          env: {
            PLAIN_ONLY: {
              type: "plain",
              value: "ok",
            },
          },
        },
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const listed = await svc.listWithAgentReferences(companyId);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: secret.id,
      name: "OPENAI_API_KEY",
      agentReferences: [
        {
          agentId: referencedAgentId,
          agentName: "CodexCoder",
          envKeys: ["OPENAI_API_KEY", "SECOND_OPENAI_KEY"],
        },
      ],
    });
  });
});
