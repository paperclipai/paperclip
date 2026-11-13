import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, applyPendingMigrations, authUsers, companies, companyMemberships, createDb,
  dotAgentBindings, dotRunnerAssignments, heartbeatRuns, issues, museAgentBindings,
  museRunnerAssignments, type Db,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../lib/dedicated-test-database-url.js";
import { accessService } from "../../services/access.js";
import * as settings from "../../services/instance-settings.js";
import * as admission from "./admission.js";
import { dotRunnerBroker } from "./dot.js";
import { museExternalAgents } from "./muse.js";

const url = resolveExternalTestDatabaseUrl("PAPERCLIP_BROKER_FEATURE_OWNER_TEST_DATABASE_URL");
const providers = ["openai_dot", "grok_bot", "muse"] as const;

describe.skipIf(!url)("external broker forwards its admission owner to feature policy", () => {
  let db: Db;
  beforeAll(async () => { await applyPendingMigrations(url!); }, 90_000);
  beforeEach(() => {
    db = createDb(url!, { maxConnections: 2, applicationName: "broker-feature-owner" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.$client.end({ timeout: 5 });
  }, 30_000);

  for (const provider of providers) it(`${provider} reads disabled policy on the exact dispatch transaction`, async () => {
    await settings.instanceSettingsService(db).updateExperimental({
      enablePublicMcp: true, enableNativeRunner: true,
      enableOpenAiDot: true, enableGrokBot: true, enableMuse: true,
    });
    const operatorId = randomUUID();
    await db.insert(authUsers).values({
      id: operatorId, name: "Feature owner operator", email: `${operatorId}@example.test`,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const [company] = await db.insert(companies).values({
      name: "Broker feature owner", issuePrefix: `BF${operatorId.replaceAll("-", "")}`,
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: operatorId,
      membershipRole: "owner", status: "active",
    });
    await accessService(db).setPrincipalPermission(company.id, "user", operatorId, "agents:create", true, operatorId);
    const [agent] = await db.insert(agents).values({
      companyId: company.id, name: provider, adapterType: "paperclip_runner", status: "active",
      adapterConfig: { provider, allowUnmeteredProvider: true },
    }).returning();
    const broker = provider === "muse"
      ? museExternalAgents(db, { publicOrigin: "https://paperclip.example" })
      : dotRunnerBroker(db);
    const pairingInput = { companyId: company.id, agentId: agent.id, operatorId };
    const pairing = provider === "muse"
      ? await museExternalAgents(db, { publicOrigin: "https://paperclip.example" }).createPairing(pairingInput)
      : await dotRunnerBroker(db).createPairing({ ...pairingInput, provider });
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Denied broker dispatch" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, issueId: issue.id, nativeIssueId: issue.id,
      status: "queued", runtimeMode: "legacy",
    }).returning();
    await settings.instanceSettingsService(db).updateExperimental({
      enableOpenAiDot: provider !== "openai_dot", enableGrokBot: provider !== "grok_bot",
      enableMuse: provider !== "muse",
    });

    const admitted = vi.spyOn(admission, "withExternalExecutionAdmission");
    const readOwners: Array<Pick<Db, "select"> | undefined> = [];
    const readValues: boolean[] = [];
    const originalSettings = settings.instanceSettingsService;
    vi.spyOn(settings, "instanceSettingsService").mockImplementation((...args) => {
      const service = originalSettings(...args);
      return {
        ...service,
        getExperimentalReadOnly: async (owner?: Pick<Db, "select">) => {
          readOwners.push(owner);
          const value = await service.getExperimentalReadOnly(owner);
          readValues.push(provider === "openai_dot" ? value.enableOpenAiDot
            : provider === "grok_bot" ? value.enableGrokBot : value.enableMuse);
          return value;
        },
      };
    });
    const snapshot = {
      companyId: company.id, agentId: agent.id, bindingId: pairing.bindingId, bindingGeneration: 1,
      acceptByUnixMs: Date.now() + 60_000, expiresAtUnixMs: Date.now() + 120_000,
    };
    const binding = { companyId: company.id, agentId: agent.id, runId: run.id };
    await expect(broker.port({ binding, provider: { binding: snapshot } }).dispatch({
      sourceEventId: randomUUID(),
      payload: {
        kind: "assignment", binding: { ...binding, bindingId: snapshot.bindingId, bindingGeneration: snapshot.bindingGeneration,
          normalizedSessionId: randomUUID(), turnId: "denied-feature", assignmentRevision: 1 },
        tools: [], acceptByUnixMs: snapshot.acceptByUnixMs, expiresAtUnixMs: snapshot.expiresAtUnixMs,
      },
    })).rejects.toMatchObject({ status: 403, message: "External binding is unavailable for new effects." });
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(admitted.mock.calls[0].slice(1, 4)).toEqual([company.id, agent.id, run.id]);
    expect(readOwners).toHaveLength(1);
    expect(readOwners[0]).toBe(admitted.mock.calls[0][0]);
    expect(readOwners[0]).not.toBe(db);
    expect(readValues).toEqual([false]);
    expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId, run.id))).toEqual([]);
    expect(await db.select().from(museRunnerAssignments).where(eq(museRunnerAssignments.runId, run.id))).toEqual([]);
    const [unchanged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(unchanged).toMatchObject({ status: "queued", runtimeMode: "legacy", nativeSessionId: null });
    if (provider === "muse") {
      const [pending] = await db.select().from(museAgentBindings).where(eq(museAgentBindings.id, pairing.bindingId));
      expect(pending).toMatchObject({ grantId: null, revokedAt: null });
    } else {
      const [pending] = await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id, pairing.bindingId));
      expect(pending).toMatchObject({ status: "pairing", grantId: null, revokedAt: null });
    }
  }, 10_000);
});
