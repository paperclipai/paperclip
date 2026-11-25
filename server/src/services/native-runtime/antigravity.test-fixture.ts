import type { Db } from "@paperclipai/db";
import { QUALIFIED_ACPX_PROFILES, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

export const ANTIGRAVITY_FIXTURE_COMPANY_ID = "10000000-0000-4000-8000-000000000001";
export const ANTIGRAVITY_FIXTURE_MODEL = "gemini-3.8-flash-low";

export function emptyDb(): Db {
  const db: Db = new Proxy(() => undefined, {
    get: (_target, key) => key === "then" ? (resolve: (rows: unknown[]) => unknown) => resolve([])
      : key === "transaction" ? async (operation: (tx: Db) => unknown) => operation(db)
      : () => db,
    apply: () => db,
  }) as unknown as Db;
  return db;
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
