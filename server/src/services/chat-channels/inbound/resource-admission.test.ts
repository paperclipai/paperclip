import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, chatEndpointResources, chatEndpoints, companies, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import type { Thread } from "chat";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createMessageResourceAdmission } from "./resource-admission.js";
import { createChatInboundAuthority } from "./authorization.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("setup destination admission with concurrent runtime invalidation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("chat-resource-admission-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  it("admits a destination while an agent-locked resource insert checks its endpoint foreign key", async () => {
    const [company] = await db.insert(companies).values({ name: "Admission" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Worker", role: "engineer",
      status: "idle", adapterType: "process" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company!.id, name: "GitHub", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company!.id, applicationId: application!.id,
      name: "GitHub", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel", status: "active" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company!.id, connectionId: connection!.id,
      provider: "github", publicId: randomUUID(), assignedAgentId: agent!.id, status: "verifying" }).returning();
    const [resource] = await db.insert(chatEndpointResources).values({ companyId: company!.id, endpointId: endpoint!.id,
      type: "repository", providerResourceId: "example/first", label: "First", enabled: false }).returning();
    let releaseEndpoint!: () => void;
    let releaseAgent!: () => void;
    const endpointLocked = new Promise<void>(resolve => { releaseEndpoint = resolve; });
    const agentLocked = new Promise<void>(resolve => { releaseAgent = resolve; });
    const authority = createChatInboundAuthority(db, {
      voiceStore: { authorizePrincipal: async () => { throw new Error("Unexpected voice authorization"); } },
      runtimeCallbackEndpoint: async () => { throw new Error("Unexpected runtime callback"); },
    });
    const admission = createMessageResourceAdmission(db, {
      ensureResource: async (...args) => {
        releaseEndpoint();
        await agentLocked;
        return authority.ensureResource(...args);
      },
    });

    const thread = { isDM: false, id: "github:example/first:1", channelId: "example/first",
      channel: { name: "example/first" } } as Thread;
    const admitting = admission.admitMessageResource({ endpoint: endpoint!, thread,
      addressed: true, suppressSetupDestinationActivation: false, surfaceKind: "native_thread" });
    const inserting = (async () => {
      await endpointLocked;
      await db.transaction(async tx => {
        await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent!.id)).for("no key update");
        releaseAgent();
        await tx.insert(chatEndpointResources).values({ companyId: company!.id, endpointId: endpoint!.id,
          type: "repository", providerResourceId: "example/second", label: "Second", enabled: false });
      });
    })();
    const results = await Promise.allSettled([admitting, inserting]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const resources = await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.endpointId, endpoint!.id));
    expect(resources).toHaveLength(2);
    expect(resources.filter(row => row.enabled).map(row => row.id)).toEqual([resource!.id]);
  });
});
