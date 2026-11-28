import type { Db } from "@paperclipai/db";
import { getTableName, type Table } from "drizzle-orm";
import { QUALIFIED_ACPX_PROFILES, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

export const ANTIGRAVITY_FIXTURE_COMPANY_ID = "10000000-0000-4000-8000-000000000001";
export const ANTIGRAVITY_FIXTURE_MODEL = "gemini-3.8-flash-low";

export type AntigravityDbRead = { table: string; locked: boolean };
export type AntigravityFixtureDb = Db & { reads: AntigravityDbRead[] };

function strict<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get: (object, key) => {
      if (typeof key === "symbol" || key in object) return Reflect.get(object, key);
      throw new Error(`antigravity fixture: unexpected ${label}.${key}`);
    },
  });
}

export function emptyDb(): AntigravityFixtureDb {
  const reads: AntigravityDbRead[] = [];
  const select = () => strict({
    from: (table: Table) => {
      const read = { table: getTableName(table), locked: false };
      reads.push(read);
      const query = strict({
        innerJoin: () => query,
        where: () => query,
        limit: () => query,
        for: (mode: string) => {
          if (mode !== "update") throw new Error(`antigravity fixture: unexpected lock ${mode}`);
          read.locked = true;
          return query;
        },
        then: (resolve: (rows: never[]) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve([] as never[]).then(resolve, reject),
      }, `select from ${read.table}`);
      return query;
    },
  }, "select");
  const db = strict({
    reads,
    select,
    transaction: async (operation: (tx: Db) => unknown) => operation(strict({ select }, "transaction") as unknown as Db),
  }, "db");
  return db as unknown as AntigravityFixtureDb;
}

export function antigravityExecution(input: { runId?: string; issueId?: string; workspaceId?: string; sessionId?: string } = {}) {
  const runId = input.runId ?? "40000000-0000-4000-8000-000000000004";
  const execution = buildNativeExecutionInput({
    companyId: ANTIGRAVITY_FIXTURE_COMPANY_ID, runId, agentId: "30000000-0000-4000-8000-000000000003",
    issue: { id: input.issueId ?? "20000000-0000-4000-8000-000000000002", identifier: "AG-1", title: "Test", description: null, workMode: "standard" },
    taskPrompt: "Only the current turn",
    workspace: { id: input.workspaceId ?? "90000000-0000-4000-8000-000000000009", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: input.sessionId ?? "60000000-0000-4000-8000-000000000006",
    provider: "acpx", acpxAgent: "antigravity", model: ANTIGRAVITY_FIXTURE_MODEL, acpxPermissionMode: "approve-all",
    completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Test", criteria: [{ id: "objective", requirement: "Answer" }] } },
    runtimeContext: nativeRuntimeContextFixture(),
  }) as NativeExecutionInput;
  (execution.provider as { profile: { agentProfileVersion: number } }).profile.agentProfileVersion =
    QUALIFIED_ACPX_PROFILES.antigravity.agentProfileVersion;
  return execution;
}
