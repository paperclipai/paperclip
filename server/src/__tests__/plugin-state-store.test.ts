import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, pluginState, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pluginStateStore } from "../services/plugin-state-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-state-store tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("plugin state store", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pluginId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-state-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(pluginState);
    await db.delete(plugins);

    pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `paperclip.state-test.${pluginId}`,
      packageName: "@paperclipai/state-test",
      version: "1.0.0",
      manifestJson: {} as never,
    });
  });

  it("treats stateKeyPrefix wildcard characters literally", async () => {
    const store = pluginStateStore(db);
    const keys = [
      "literal:%:match",
      "literal:X:match",
      "literal:_:match",
      "literal:A:match",
      "literal:\\:match",
      "literal::match",
    ];

    for (const stateKey of keys) {
      await store.set(pluginId, {
        scopeKind: "instance",
        stateKey,
        value: { stateKey },
      });
    }

    await expectKeysForPrefix("literal:%", ["literal:%:match"]);
    await expectKeysForPrefix("literal:_", ["literal:_:match"]);
    await expectKeysForPrefix("literal:\\", ["literal:\\:match"]);

    async function expectKeysForPrefix(prefix: string, expected: string[]) {
      const result = await store.list(pluginId, {
        scopeKind: "instance",
        stateKeyPrefix: prefix,
        limit: 10,
      });

      expect(result.rows.map((row) => row.stateKey)).toEqual(expected);
      expect(result.hasMore).toBe(false);
    }
  });
});
