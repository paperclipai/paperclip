import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { initializeRunIdentity } from "../../services/run-identity.js";

export async function seedIdentityProjection(db: Db) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), messageId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic identity", issuePrefix: companyId });
  await db.insert(agents).values({ id: agentId, companyId, name: "Identity reader", adapterType: "process" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Identity task", assigneeAgentId: agentId,
    conversationAgentId: agentId, conversationUserId: "operator", conversationState: "active", conversationSessionGeneration: 3, workMode: "standard" });
  const payloads = { contextSnapshot: { issueId, conversationSessionGeneration: 3, paperclipSkillTest: false,
    projectId: randomUUID(), routineId: randomUUID(), paperclipIssue: { id: issueId, projectId: randomUUID(),
      responsibleUserId: "nested-user", document: randomBytes(8_192).toString("base64") },
    savedInput: randomBytes(96 * 1_024).toString("base64") },
    runnerProfileJson: { nativeExecutionInput: { savedInput: randomBytes(48 * 1_024).toString("base64") },
      unrelatedProfileDocument: randomBytes(8_192).toString("base64") },
    resultJson: { retained: randomBytes(4_096).toString("base64") }, stdoutExcerpt: "retained stdout", stderrExcerpt: "retained stderr" };
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", nativeIssueId: issueId,
    runtimeMode: "native", invocationSource: "automation", ...payloads });
  await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorUserId: "next-user", body: "New request" });
  const context = await initializeRunIdentity(db, { companyId, runId, issueId, responsibleUserId: "operator", cause: "instruction" });
  return { companyId, agentId, issueId, runId, messageId, context, payloads };
}

export type IdentityQuery = { sql: string; params: unknown[] };
export function captureIdentityQueries(db: Db, queries: IdentityQuery[]): Db {
  return new Proxy(db, { get(target, key) {
    if (key === "transaction") return (action: (tx: Db) => Promise<unknown>) =>
      target.transaction(tx => action(captureIdentityQueries(tx as unknown as Db, queries)));
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const selection = from(...args), execute = selection.execute.bind(selection);
        selection.execute = async () => { queries.push(selection.toSQL()); return execute(); };
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
}
