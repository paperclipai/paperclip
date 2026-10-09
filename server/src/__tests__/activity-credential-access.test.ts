import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { activityService } from "../services/activity.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("task credential-access run summary", () => {
  let db: ReturnType<typeof createDb>;
  let temporaryDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporaryDb = await startEmbeddedPostgresTestDatabase("credential-access-summary-");
    db = createDb(temporaryDb.connectionString);
  }, 60_000);
  afterAll(async () => { await temporaryDb?.cleanup(); });
  it("projects only bounded credential-access display metadata in task runs", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Credential fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Credential denial", status: "blocked", assigneeAgentId: agentId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, scopeKind: "issue", issueId,
      status: "failed", errorCode: "configuration_incomplete", error: "This credential is not shared with the responsible user",
      resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared",
        credentialAccess: { connectionName: "Dotta’s API Key".repeat(30), secretValue: "must-not-leak" },
        fingerprint: "must-not-leak", unrelated: "must-not-leak" } },
    });
    const runs = await activityService(db).runsForIssue(companyId, issueId);
    expect(runs[0]?.error).toBe("This credential is not shared with the responsible user");
    expect(runs[0]?.resultJson).toEqual({ configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared",
      credentialAccess: { connectionName: "Dotta’s API Key".repeat(30).slice(0, 240) } } });
    await db.update(heartbeatRuns).set({ resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_unavailable", credentialAccess: { connectionName: "hidden" } } } }).where(eq(heartbeatRuns.id, runId));
    expect((await activityService(db).runsForIssue(companyId, issueId))[0]?.resultJson).toEqual({});
  });

});
