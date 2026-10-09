import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { activeIssueInteractionCondition } from "./issue-question-context.js";

describe("AI connection wait audience", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("connection-wait-audience-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  it.each(["other_user", "same_user", "unknown_user", "unaddressed", "tool_access", "foreign_run", "missing_run"])(
    "uses the current run's user when selecting native connection waits (%s)", async audience => {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Wait audience", issuePrefix: `W${companyId.slice(0, 8)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Fresh user turn", assigneeAgentId: agentId });
      let runCompanyId = companyId;
      if (audience === "foreign_run") {
        runCompanyId = randomUUID();
        await db.insert(companies).values({ id: runCompanyId, name: "Other company", issuePrefix: `F${runCompanyId.slice(0, 8)}` });
      }
      if (audience !== "missing_run") await db.insert(heartbeatRuns).values({
        id: runId, companyId: runCompanyId, agentId, status: "running",
        responsibleUserId: audience === "unknown_user" ? null : "board",
      });
      const [interaction] = await db.insert(issueThreadInteractions).values({
        companyId, issueId, kind: "connection_intent", status: "pending", createdByAgentId: agentId,
        addresseeUserId: audience === "unaddressed" ? null : audience === "same_user" ? "board" : "other-user",
        effectiveResolverPolicy: "human_only",
        payload: { version: 1, ...(audience === "tool_access" ? {} : { purpose: "ai" as const }),
          serviceSlug: "openai", serviceName: "OpenAI", requestingAgentId: agentId,
          requestingAgentName: "Worker", phase: "requested" },
      }).returning();
      const waits = await db.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"), activeIssueInteractionCondition({ runId }),
      ));
      expect(waits).toHaveLength(audience === "other_user" ? 0 : 1);
      // Context-free readers retain the pending card and its authorization gate.
      expect(await db.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, interaction.id), activeIssueInteractionCondition(),
      ))).toEqual([interaction]);
    },
  );
});
