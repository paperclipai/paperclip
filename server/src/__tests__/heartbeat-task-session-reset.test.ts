import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

describePostgres("task-scoped runtime session reset", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase(
      "paperclip-task-session-reset-",
    );
    db = createDb(database.connectionString);
  }, 20_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const foreignAgentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const foreignIssueId = randomUUID();
    const identifier = `RESET-${randomUUID().slice(0, 8).toUpperCase()}-1`;
    const otherIdentifier = `${identifier}-OTHER`;
    const foreignIdentifier = `${identifier}-FOREIGN`;
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Reset fixture",
        issuePrefix: `R${companyId.slice(0, 8).toUpperCase()}`,
      },
      {
        id: otherCompanyId,
        name: "Other reset fixture",
        issuePrefix: `R${otherCompanyId.slice(0, 8).toUpperCase()}`,
      },
    ]);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Selected agent",
        adapterType: "paperclip_runner",
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other agent",
        adapterType: "paperclip_runner",
      },
      {
        id: foreignAgentId,
        companyId: otherCompanyId,
        name: "Foreign agent",
        adapterType: "paperclip_runner",
      },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Selected task", identifier },
      {
        id: otherIssueId,
        companyId,
        title: "Other task",
        identifier: otherIdentifier,
      },
      {
        id: foreignIssueId,
        companyId: otherCompanyId,
        title: "Foreign task",
        identifier: foreignIdentifier,
      },
    ]);
    const taskSessions = [
      { taskKey: issueId },
      { taskKey: identifier },
      { taskKey: otherIssueId },
      { taskKey: otherIdentifier },
      { taskKey: identifier, adapterType: "codex_local" },
      { taskKey: identifier, agentId: otherAgentId },
      {
        taskKey: identifier,
        companyId: otherCompanyId,
        agentId: foreignAgentId,
      },
      { taskKey: "__heartbeat__" },
      { taskKey: "custom:opaque-task" },
      {
        taskKey: "model-claimed-alias",
        sessionParamsJson: { issueId, taskKey: identifier },
      },
      { taskKey: foreignIssueId },
      { taskKey: foreignIdentifier },
    ].map((row) => ({
      id: randomUUID(),
      companyId,
      agentId,
      adapterType: "paperclip_runner",
      sessionDisplayId: randomUUID(),
      sessionParamsJson: { preserved: true },
      ...row,
    }));
    await db.insert(agentTaskSessions).values(taskSessions);
    await db.insert(agentRuntimeState).values([
      {
        agentId,
        companyId,
        adapterType: "paperclip_runner",
        sessionId: "selected-legacy",
        stateJson: { preserved: true },
      },
      {
        agentId: otherAgentId,
        companyId,
        adapterType: "paperclip_runner",
        sessionId: "other-legacy",
        stateJson: { untouched: true },
      },
    ]);
    const before = await db.select().from(agentTaskSessions);
    const runtimeBefore = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, otherAgentId));
    return {
      companyId,
      agentId,
      otherAgentId,
      issueId,
      identifier,
      foreignIssueId,
      before,
      runtimeBefore,
    };
  }

  it.each(["uuid", "identifier", "lowercase_identifier"] as const)(
    "clears only the selected task's UUID and identifier sessions via %s",
    async (keyKind) => {
      const seeded = await fixture();
      const taskKey =
        keyKind === "uuid"
          ? seeded.issueId
          : keyKind === "identifier"
            ? seeded.identifier
            : seeded.identifier.toLowerCase();
      const service = heartbeatService(db);
      const reset = await service.resetRuntimeSession(seeded.agentId, {
        taskKey,
      });
      expect(reset?.clearedTaskSessions).toBe(2);
      const expected = seeded.before.filter(
        (row) =>
          !(
            row.companyId === seeded.companyId &&
            row.agentId === seeded.agentId &&
            row.adapterType === "paperclip_runner" &&
            [seeded.issueId, seeded.identifier].includes(row.taskKey)
          ),
      );
      expect(
        (await db.select().from(agentTaskSessions)).sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      ).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
      expect(reset?.stateJson).toEqual({ preserved: true });
      expect(
        await db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, seeded.otherAgentId)),
      ).toEqual(seeded.runtimeBefore);
      expect(
        (await service.resetRuntimeSession(seeded.agentId, { taskKey }))
          ?.clearedTaskSessions,
      ).toBe(0);
    },
  );

  it.each(["__heartbeat__", "custom:opaque-task"])(
    "preserves exact opaque key reset for %s",
    async (taskKey) => {
      const seeded = await fixture();
      const reset = await heartbeatService(db).resetRuntimeSession(
        seeded.agentId,
        { taskKey },
      );
      expect(reset?.clearedTaskSessions).toBe(1);
      const expected = seeded.before.filter(
        (row) => !(row.agentId === seeded.agentId && row.taskKey === taskKey),
      );
      expect(
        (await db.select().from(agentTaskSessions)).sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      ).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
    },
  );

  it("never expands a foreign issue's aliases, while preserving exact local opaque-key deletion", async () => {
    const seeded = await fixture();
    const reset = await heartbeatService(db).resetRuntimeSession(
      seeded.agentId,
      { taskKey: seeded.foreignIssueId },
    );
    expect(reset?.clearedTaskSessions).toBe(1);
    const expected = seeded.before.filter(
      (row) =>
        !(
          row.agentId === seeded.agentId &&
          row.taskKey === seeded.foreignIssueId
        ),
    );
    expect(
      (await db.select().from(agentTaskSessions)).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    ).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("retains the existing explicit all-sessions reset without touching other agents", async () => {
    const seeded = await fixture();
    const reset = await heartbeatService(db).resetRuntimeSession(
      seeded.agentId,
    );
    const expected = seeded.before.filter(
      (row) => row.agentId !== seeded.agentId,
    );
    expect(reset?.clearedTaskSessions).toBe(
      seeded.before.length - expected.length,
    );
    expect(reset?.stateJson).toEqual({});
    expect(
      (await db.select().from(agentTaskSessions)).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    ).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
  });
});
