import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, connectionGrants, connectionGrantMembers, createDb, heartbeatRuns, issues, toolApplications, toolConnections } from "@paperclipai/db";
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
    const applicationId = randomUUID(), connectionId = randomUUID(), grantId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "AI fixture", type: "rest_api" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Dotta’s API Key", uid: "credential-fixture", connectionPurpose: "ai", transport: "runtime_auth" });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "user", subjectUserId: "dotta" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, scopeKind: "issue", issueId,
      responsibleUserId: "nicky",
      status: "failed", errorCode: "configuration_incomplete", error: "This credential is not shared with the responsible user",
      resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared",
        credentialAccess: { connectionName: "Dotta’s API Key".repeat(30), grantId, secretValue: "must-not-leak" },
        fingerprint: "must-not-leak", unrelated: "must-not-leak" } },
    });
    const service = activityService(db);
    const runs = await service.runsForIssue(companyId, issueId, "nicky");
    expect(runs[0]?.error).toBe("This credential is not shared with the responsible user");
    expect(runs[0]?.resultJson).toEqual({ configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared",
      credentialAccess: { connectionName: "Dotta’s API Key".repeat(30).slice(0, 240) } } });
    expect((await service.runsForIssue(companyId, issueId, "dotta"))[0]?.resultJson).toEqual(runs[0]?.resultJson);
    const hidden = { configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared", credentialAccess: {} } };
    expect((await service.runsForIssue(companyId, issueId, "another-reader"))[0]?.resultJson).toEqual(hidden);
    expect((await service.runsForIssue(companyId, issueId))[0]?.resultJson).toEqual(hidden);

    // Organization credentials follow the same audience rules as Connections.
    await db.update(connectionGrants).set({ kind: "organization", subjectUserId: null }).where(eq(connectionGrants.id, grantId));
    expect((await service.runsForIssue(companyId, issueId, "another-reader"))[0]?.resultJson).toEqual(runs[0]?.resultJson);
    await db.insert(connectionGrantMembers).values({ companyId, grantId, subjectType: "user", subjectId: "dotta" });
    expect((await service.runsForIssue(companyId, issueId, "dotta"))[0]?.resultJson).toEqual(runs[0]?.resultJson);
    expect((await service.runsForIssue(companyId, issueId, "another-reader"))[0]?.resultJson).toEqual(hidden);

    // A resumed native execution keeps its diagnostic name without acquiring
    // the fresh-execution selection-failure marker used by recovery.
    await db.update(heartbeatRuns).set({ resultJson: { configurationIncomplete: {
      credentialAccess: { connectionName: "Dotta’s API Key", grantId },
    } } }).where(eq(heartbeatRuns.id, runId));
    expect((await service.runsForIssue(companyId, issueId, "nicky"))[0]?.resultJson).toEqual({
      configurationIncomplete: { credentialAccess: { connectionName: "Dotta’s API Key" } },
    });
    await db.update(heartbeatRuns).set({ error: null, resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_unavailable", credentialAccess: { connectionName: "hidden" } } } }).where(eq(heartbeatRuns.id, runId));
    expect((await service.runsForIssue(companyId, issueId, "nicky"))[0]?.resultJson).toEqual({});
  });

});
