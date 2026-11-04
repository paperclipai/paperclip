import type { ContinuationCheckpoint } from "./continuation-scoring.js";
import { createHash } from "node:crypto";
import type { ExecutionWorkspace, WorkspaceFileContent } from "../../packages/shared/src/index.js";
import type { RunnerApi } from "./api.js";
import type { StoryCheck } from "./everyday-observations.js";
import type { MatrixExecution } from "./types.js";

export function isLegacyWorkspaceMigration(execution: MatrixExecution) {
  return ["legacy-workspace-migration", "legacy-workspace-migration-warm"].includes(execution.suite.id);
}

export function legacyWorkspaceMigrationPrompt(prompt: string) {
  const continuation = prompt.replace("Do not create other tasks or deliverables.", "Do not create other tasks.");
  return `Work in this task's own workspace. Before asking the question, create migration-reference.txt containing a fresh random 32-character lowercase hexadecimal reference and a trailing newline. Do not deliver any files or documents before I answer. After I answer, read this same file, keep its original bytes, and attach the original migration-reference.txt as an additional deliverable alongside the confirmation document. Include a clickable Markdown link to the saved confirmation document in your final reply; its title or key alone is not a link. ${continuation}`;
}

export interface MigrationPoint {
  workspaceId: string; providerType: string; migrated: boolean; proofSha256: string;
  runId: string; sessionId: string; providerSessionSha256: string; logicalCwd: string; remoteCwd: string;
}

export async function readMigrationPoint(input: { api: Pick<RunnerApi, "get">; companyId: string; agentId: string; issueId: string }): Promise<MigrationPoint> {
  const { workspace } = await input.api.get<{ workspace: ExecutionWorkspace | null }>(`/api/issues/${input.issueId}/workspace`);
  if (!workspace || workspace.companyId !== input.companyId) throw new Error("Migration oracle has no bound workspace");
  const runs = await input.api.get<Array<{ runId: string; status: string; agentId: string; finishedAt: string }>>(`/api/issues/${input.issueId}/runs`);
  const latest = runs.filter(run => run.agentId === input.agentId && run.status === "succeeded")
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
  if (!latest || runs.some(run => ["queued", "running"].includes(run.status))) throw new Error("Migration requires a settled retained turn");
  const run = await input.api.get<Record<string, any>>(`/api/heartbeat-runs/${latest.runId}`);
  const execution = run.runnerProfileJson?.nativeExecutionInput;
  const reference = run.runnerProfileJson?.nativeWorkspaceSync ?? run.runnerProfileJson?.remoteWorkspace;
  if (run.companyId !== input.companyId || run.agentId !== input.agentId || run.nativeIssueId !== input.issueId
    || run.runtimeMode !== "native" || !run.nativeSessionId || typeof run.sessionIdAfter !== "string" || !run.sessionIdAfter
    || execution?.binding?.executionWorkspaceId !== workspace.id
    || !execution?.workspace?.cwd || !reference?.remoteCwd) throw new Error("Migration run identity is incomplete");
  const file = await input.api.get<WorkspaceFileContent>(`/api/issues/${input.issueId}/file-resources/content?workspace=execution&path=migration-reference.txt`);
  if (file.resource?.workspaceId !== workspace.id || file.content?.encoding !== "utf8"
    || !/^[a-f0-9]{32}\n$/.test(file.content.data)) throw new Error("Migration reference bytes are missing");
  return { workspaceId: workspace.id, providerType: workspace.providerType,
    migrated: Boolean(workspace.metadata?.nativeWorkspaceMigration),
    proofSha256: createHash("sha256").update(file.content.data).digest("hex"),
    runId: run.id, sessionId: run.nativeSessionId, providerSessionSha256: createHash("sha256").update(run.sessionIdAfter).digest("hex"),
    logicalCwd: execution.workspace.cwd, remoteCwd: reference.remoteCwd };
}

function migrationReferenceAttachments(checkpoints: ContinuationCheckpoint[], before?: MigrationPoint, after?: MigrationPoint) {
  if (!before || !after || before.proofSha256 !== after.proofSha256) return [];
  return (checkpoints.find(point => point.phase === "final")?.attachments ?? []).filter(value => {
    const file = value as Record<string, unknown>;
    return file.originalFilename === "migration-reference.txt" && file.contentVerified === true
      && typeof file.body === "string" && file.contentSha256 === before.proofSha256
      && createHash("sha256").update(file.body).digest("hex") === before.proofSha256;
  });
}

export function migrationPrimaryOutputCheckpoints(checkpoints: ContinuationCheckpoint[], before?: MigrationPoint, after?: MigrationPoint) {
  const references = migrationReferenceAttachments(checkpoints, before, after);
  if (references.length !== 1) return checkpoints;
  return checkpoints.map(point => point.phase === "final"
    ? { ...point, attachments: point.attachments.filter(file => file !== references[0]) } : point);
}

export function gradeLegacyWorkspaceMigration(before?: MigrationPoint, after?: MigrationPoint, checkpoints: ContinuationCheckpoint[] = []): StoryCheck[] {
  return [{ id: "legacy-workspace-migration-continuation", passed: Boolean(before && after && !before.migrated && after.migrated
    && before.providerType !== "cloud_sandbox" && after.providerType === "cloud_sandbox" && before.workspaceId === after.workspaceId
    && before.runId !== after.runId && before.sessionId === after.sessionId && before.logicalCwd === after.logicalCwd
    && before.remoteCwd === after.remoteCwd && before.proofSha256 === after.proofSha256 && before.providerSessionSha256 === after.providerSessionSha256),
  detail: "A new turn retains the exact native session, logical and provider paths, workspace, and reference file bytes after offline migration and destruction of the old home." },
  { id: "legacy-workspace-migration-reference-delivered", passed: migrationReferenceAttachments(checkpoints, before, after).length === 1,
    detail: "The one requested reference attachment has the exact original workspace bytes, independently downloaded and verified." }];
}
