export interface TaskWorkspaceCheckpoint {
  turn: number;
  issue: { id: string; projectId: string | null; executionWorkspaceId: string | null; status: string; scheduledRetry?: unknown };
  workspace: { id: string; projectId: string | null; cwd: string };
  confinedTaskRoot: boolean;
  note: string;
  repositories: Array<{ id: string; state: string; relativePath: string; pinnedCommit: string | null; requestedByIssueId: string | null; requestKeys: string[] }>;
  run: { id: string; status: string; runtimeMode?: string; nativePhase?: string; nativeBinding?: string; nativeCwd?: string; transport?: string; authenticated?: boolean; nativeCompleted?: boolean };
  repository?: { head: string; baseIsAncestor: boolean; dirty: boolean; content: string };
  prepareCalls?: number;
}
export interface TaskWorkspaceObservation {
  nonce: string;
  native: boolean;
  daytona: boolean;
  initial: { workspaceId: string; cwd: string; repositories: number } | null;
  checkpoints: TaskWorkspaceCheckpoint[];
  projectCount: number;
  runCount: number;
  restarted: boolean;
  pendingInteractions: number;
  activeOperations: number;
  activeRecovery: boolean;
  artifact: { content: string; contentVerified: boolean; mimeType: string } | null;
  remoteLeaseRunIds: string[];
}

/** Every check uses independent persisted/API/filesystem evidence, never model assertions. */
export function gradeTaskWorkspaces(value: TaskWorkspaceObservation) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const [first, second, third] = value.checkpoints;
  const complete = value.checkpoints.length === 3 && value.checkpoints.every((p, i) => p.turn === i + 1);
  check("three-attributed-turns", complete && value.runCount === 3 && new Set(value.checkpoints.map(p => p.run.id)).size === 3
    && value.checkpoints.every(p => p.run.status === "succeeded" && p.issue.status === "done" && p.issue.scheduledRetry == null),
  "Exactly three successful requested turns with no hidden retries or unfinished tasks.");
  check("projectless-task-owned-root", complete && value.projectCount === 0 && value.checkpoints.every(p =>
    p.issue.projectId === null && p.workspace.projectId === null && p.confinedTaskRoot && p.issue.executionWorkspaceId === p.workspace.id),
  "Task and execution workspace remain projectless, with a confined company/task directory rather than agent home.");
  // The provider may enqueue its receipt before the first browser observation.
  // Deferred acquisition is checked at the settled first-turn checkpoint below.
  check("immutable-root-and-binding", complete && value.initial !== null &&
    value.checkpoints.every(p => p.workspace.id === value.initial!.workspaceId && p.workspace.cwd === value.initial!.cwd),
  "The independently observed initial root and binding survive all three admissions.");
  check("task-file-continuity", complete && value.checkpoints.every(p => p.note === `task-files-turn-${p.turn}-${value.nonce}\n`),
  "Public execution-workspace file reads match the exact expected bytes after every turn.");
  const a = first?.repositories[0], b = second?.repositories[0], c = third?.repositories[0];
  check("deferred-idempotent-acquisition", complete && value.checkpoints.every(p => p.repositories.length === 1 &&
    p.repositories[0]?.requestedByIssueId === p.issue.id && p.repositories[0]?.requestKeys.length === 1 && p.repositories[0]?.requestKeys[0] === `repository-${value.nonce}`)
    && a?.state === "pending" && a.pinnedCommit === null && a.id === b?.id && a.id === c?.id
    && /^\.paperclip-repositories\/task-repo-[a-f0-9]{24}$/.test(a.relativePath)
    && a.relativePath === b?.relativePath && a.relativePath === c?.relativePath && b?.state === "ready" && c?.state === "ready"
    && /^[a-f0-9]{40,64}$/.test(b?.pinnedCommit ?? "") && b?.pinnedCommit === c?.pinnedCommit,
  "Duplicate preparation converges to one pending receipt, realized only on the next admission with a stable contained path and pinned source.");
  check("nested-git-and-dirty-files", complete && second?.repository !== undefined && third?.repository !== undefined
    && second.repository.baseIsAncestor && third.repository.baseIsAncestor && second.repository.head !== b?.pinnedCommit
    && second.repository.head === third.repository.head && second.repository.dirty && third.repository.dirty
    && second.repository.content === `repository-dirty-${value.nonce}\n` && third.repository.content === second.repository.content,
  "A new local commit and subsequent uncommitted bytes in a nested repository survive the next admission.");
  check("controller-restart", value.restarted && complete, "The isolated controller restarted between the first and second requested turns.");
  check("downloaded-artifact", value.artifact?.contentVerified === true && value.artifact.mimeType === "text/plain"
    && value.artifact.content === `repository-dirty-${value.nonce}\n`,
  "The final run's registered downloadable artifact has verified metadata, digest and exact prior repository bytes.");
  check("settled-control-plane", value.pendingInteractions === 0 && value.activeOperations === 0 && !value.activeRecovery,
    "No unanswered decision, workspace operation or scheduled native recovery remains.");
  check("runtime-and-transport", complete && value.checkpoints.every(p => value.native
    ? p.run.runtimeMode === "native" && p.run.nativePhase === "committed" && p.run.nativeCompleted === true && p.run.nativeBinding === p.workspace.id
      && typeof p.run.nativeCwd === "string" && p.run.nativeCwd.length > 0
      && p.run.transport === (value.daytona ? "provider_ingress" : "local_loopback") && (!value.daytona || p.run.authenticated === true)
    : p.run.runtimeMode === "legacy"), "Each observed run uses the selected actual runtime and native transport/admitted binding.");
  check("semantic-repository-tool", !value.native || first?.prepareCalls === 2,
    "Native preparation uses two successful real prepare_repository tool calls, not a model-authored clone command.");
  check("daytona-run-leases", !value.daytona || (complete && value.checkpoints.every(p => value.remoteLeaseRunIds.includes(p.run.id))),
    "Every remote turn has a public Daytona environment lease attributed to that run.");
  return checks;
}

/** Count durable runner receipts, including the provider's normalized tool name. */
export function isRepositoryPreparationReceipt(event: {
  eventType?: string;
  payload?: { prpEvent?: { sourceKind?: string; runId?: string; payload?: { name?: string; status?: string } } };
}, runId: string) {
  const receipt = event.payload?.prpEvent;
  return event.eventType === "tool.execution.completed" && receipt?.sourceKind === "runner"
    && receipt.runId === runId && receipt.payload?.status === "completed"
    && ["prepare_repository", "paperclip.prepare_repository", "paperclip_prepare_repository"].includes(receipt.payload.name ?? "");
}
