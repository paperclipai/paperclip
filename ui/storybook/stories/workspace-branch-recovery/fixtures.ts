import type { WorkspaceBaseRefRecoveryNoticeProps } from "@/components/WorkspaceBaseRefRecoveryNotice";

export const evidence = {
  requestedRef: "main",
  repository: "paperclipai/paperclip",
  defaultBranch: "master",
  agentName: "Felix Novak",
  configuredBy: "Miranda Cole, when creating this task",
  failureKind: "missing_branch",
} satisfies Omit<WorkspaceBaseRefRecoveryNoticeProps, "onRepair">;

export async function simulateRepair(branch: string) {
  await new Promise(resolve => window.setTimeout(resolve, 700));
  if (branch !== "master" && branch !== "release/next") throw new Error(`Branch “${branch}” was not found. Choose an existing branch.`);
}
