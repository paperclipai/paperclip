import type { Issue } from "@paperclipai/shared";

export type WorkflowPhase = {
  id: string;
  label: string;
  hint: string;
  match: RegExp;
};

export const WORKFLOW_PHASES: WorkflowPhase[] = [
  { id: "requirements", label: "需求", hint: "目標、限制、驗收", match: /需求|分析|requirement|scope|brief/i },
  { id: "design", label: "設計", hint: "方案、原型、架構", match: /設計|方案|原型|架構|design|prototype|plan/i },
  { id: "build", label: "實作", hint: "開發、整合、產出", match: /實作|開發|工程|程式|build|develop|implement|code/i },
  { id: "test", label: "測試", hint: "檢查、驗收、風險", match: /測試|檢查|驗收|品保|test|qa|review/i },
  { id: "retro", label: "覆盤", hint: "紀錄、討論、下一步", match: /覆盤|會議|討論|紀錄|retro|meeting|discussion|notes/i },
];

export const OTHER_WORKFLOW_PHASE: WorkflowPhase = {
  id: "other",
  label: "其它",
  hint: "未分類工作",
  match: /.^/,
};

export function workflowPhaseForIssue(issue: Pick<Issue, "title" | "description">): WorkflowPhase {
  const titlePhase = WORKFLOW_PHASES.find((phase) => phase.match.test(issue.title));
  if (titlePhase) return titlePhase;

  const text = `${issue.title} ${issue.description ?? ""}`;
  return WORKFLOW_PHASES.find((phase) => phase.match.test(text)) ?? OTHER_WORKFLOW_PHASE;
}

export function isSystemRecoveryIssue(issue: Pick<Issue, "originKind" | "title">): boolean {
  return String(issue.originKind ?? "") === "stranded_issue_recovery" || issue.title.startsWith("Recover stalled issue ");
}

export function isUnresolvedIssue(issue: Pick<Issue, "status">): boolean {
  return issue.status !== "done" && issue.status !== "cancelled";
}
