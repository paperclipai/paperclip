import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companyMemberships, createDb } from "@paperclipai/db";
import type { PluginCapability } from "@paperclipai/shared";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const pluginId = "plugin-record-id";
const pluginKey = "paperclip.gateway";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

describeEmbeddedPostgres("plugin activity log human attribution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const disposers: Array<() => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-activity-attribution-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await db.delete(activityLog);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix: string) {
    return db
      .insert(companies)
      .values({
        name: `${prefix} ${randomUUID()}`,
        issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function addHumanMember(
    companyId: string,
    { status = "active", membershipRole = "operator" }: { status?: string; membershipRole?: string } = {},
  ) {
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status,
      membershipRole,
    });
    return userId;
  }

  /**
   * Drive `ctx.activity.log` the way a worker call reaches the host: through
   * the capability-gated host client handlers, inside an invocation scoped to
   * the entry's company.
   */
  function pluginActivityLog(capabilities: PluginCapability[]) {
    const services = buildHostServices(db, pluginId, pluginKey, createEventBusStub());
    disposers.push(() => services.dispose());
    const handlers = createHostClientHandlers({ pluginId, capabilities, services });
    return (params: Parameters<(typeof handlers)["activity.log"]>[0]) =>
      handlers["activity.log"](params, { invocationScope: { companyId: params.companyId } });
  }

  const bothCapabilities: PluginCapability[] = ["activity.log.write", "activity.log.write_human_attributed"];

  it("writes a plugin action carrying the verified user as initiating actor when actorUserId is an active human member", async () => {
    const company = await createCompany("PAH");
    const userId = await addHumanMember(company.id);
    const log = pluginActivityLog(bothCapabilities);

    await log({
      companyId: company.id,
      message: "chat.message_relayed",
      entityType: "issue",
      entityId: "issue-1",
      metadata: { roomId: "room-1" },
      actorUserId: userId,
    });

    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: company.id,
      actorType: "plugin",
      actorId: pluginId,
      action: "chat.message_relayed",
      entityType: "issue",
      entityId: "issue-1",
    });
    expect(rows[0]!.details).toMatchObject({
      roomId: "room-1",
      pluginId,
      sourcePluginId: pluginId,
      sourcePluginKey: pluginKey,
      initiatingActorType: "user",
      initiatingActorId: userId,
      initiatingUserId: userId,
    });
  });

  it("refuses actorUserId when the plugin lacks activity.log.write_human_attributed", async () => {
    const company = await createCompany("PAC");
    const userId = await addHumanMember(company.id);
    const log = pluginActivityLog(["activity.log.write"]);

    await expect(
      log({ companyId: company.id, message: "chat.message_relayed", actorUserId: userId }),
    ).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });

    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("refuses an actorUserId that is not a member of the company", async () => {
    const company = await createCompany("PAN");
    const log = pluginActivityLog(bothCapabilities);

    await expect(
      log({ companyId: company.id, message: "chat.message_relayed", actorUserId: randomUUID() }),
    ).rejects.toThrow("is not an active human member of this company");

    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("refuses an actorUserId whose membership is not active", async () => {
    const company = await createCompany("PAI");
    const suspendedUserId = await addHumanMember(company.id, { status: "suspended" });
    const log = pluginActivityLog(bothCapabilities);

    await expect(
      log({ companyId: company.id, message: "chat.message_relayed", actorUserId: suspendedUserId }),
    ).rejects.toThrow("is not an active human member of this company");

    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("refuses a viewer-role (read-only) member, like other human-attributed writes", async () => {
    const company = await createCompany("PAV");
    const viewerUserId = await addHumanMember(company.id, { membershipRole: "viewer" });
    const log = pluginActivityLog(bothCapabilities);

    await expect(
      log({ companyId: company.id, message: "chat.message_relayed", actorUserId: viewerUserId }),
    ).rejects.toThrow("has viewer (read-only) access");

    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("refuses an actorUserId who is only a member of another company", async () => {
    const company = await createCompany("PAX");
    const otherCompany = await createCompany("PAY");
    const otherCompanyUserId = await addHumanMember(otherCompany.id);
    const log = pluginActivityLog(bothCapabilities);

    await expect(
      log({ companyId: company.id, message: "chat.message_relayed", actorUserId: otherCompanyUserId }),
    ).rejects.toThrow("is not an active human member of this company");

    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("refuses a human-attributed entry for another company than the invocation is scoped to", async () => {
    const companyA = await createCompany("PAA");
    const companyB = await createCompany("PAB");
    const companyBUserId = await addHumanMember(companyB.id);
    const services = buildHostServices(db, pluginId, pluginKey, createEventBusStub());
    disposers.push(() => services.dispose());
    const handlers = createHostClientHandlers({ pluginId, capabilities: bothCapabilities, services });

    await expect(
      handlers["activity.log"](
        { companyId: companyB.id, message: "chat.message_relayed", actorUserId: companyBUserId },
        { invocationScope: { companyId: companyA.id } },
      ),
    ).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });

    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("keeps writing a plugin-attributed entry when actorUserId is left out", async () => {
    const company = await createCompany("PAP");
    const log = pluginActivityLog(["activity.log.write"]);

    await log({ companyId: company.id, message: "sync.completed", metadata: { synced: 3 } });

    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: company.id,
      actorType: "plugin",
      actorId: pluginId,
      action: "sync.completed",
      entityType: "plugin",
      entityId: pluginId,
    });
    expect(rows[0]!.details).toMatchObject({
      synced: 3,
      pluginId,
      initiatingActorType: null,
      initiatingUserId: null,
    });
  });
});
