import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  persistActivity,
  publishActivity,
  setPluginEventBus,
} from "../services/activity-log.ts";
import type { PluginEventBus } from "../services/plugin-event-bus.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity plugin-event bridge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("activity log plugin event bridge", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  const emitted: PluginEvent[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-bridge-");
    db = createDb(tempDb.connectionString);
    setPluginEventBus({
      emit: async (event: PluginEvent) => {
        emitted.push(event);
        return { errors: [] };
      },
      forPlugin: () => {
        throw new Error("not used in this test");
      },
      clearPlugin: () => {},
      subscriptionCount: () => 0,
    } satisfies PluginEventBus);
  }, 20_000);

  beforeEach(async () => {
    emitted.length = 0;
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    setPluginEventBus(null as unknown as PluginEventBus);
    await tempDb?.cleanup();
  });

  async function logAndPublish(action: string, entityId: string) {
    const { publication } = await persistActivity(db, {
      companyId,
      actorType: "agent",
      actorId: randomUUID(),
      action,
      entityType: "issue",
      entityId,
    });
    publishActivity(publication);
    // publishPluginDomainEvent emits asynchronously; flush the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
    return publication.pluginEvent;
  }

  it("bridges issue.child_created to issue.created for plugin subscribers", async () => {
    const childIssueId = randomUUID();

    const pluginEvent = await logAndPublish("issue.child_created", childIssueId);

    expect(pluginEvent).not.toBeNull();
    expect(pluginEvent?.eventType).toBe("issue.created");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.eventType).toBe("issue.created");
    expect(emitted[0]?.entityType).toBe("issue");
    expect(emitted[0]?.entityId).toBe(childIssueId);
    expect(emitted[0]?.companyId).toBe(companyId);
  });

  it("keeps passing a native issue.created action through unchanged", async () => {
    const issueId = randomUUID();

    const pluginEvent = await logAndPublish("issue.created", issueId);

    expect(pluginEvent?.eventType).toBe("issue.created");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.entityId).toBe(issueId);
  });

  it("does not emit a plugin event for unmapped activity actions", async () => {
    const pluginEvent = await logAndPublish("issue.child_reordered", randomUUID());

    expect(pluginEvent).toBeNull();
    expect(emitted).toHaveLength(0);
  });
});
