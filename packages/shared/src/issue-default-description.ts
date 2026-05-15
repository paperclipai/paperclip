export const DEFAULT_ISSUE_WORKFLOW_CLASS = "Normal";

export const DEFAULT_ISSUE_CONSTITUTION_BODY = [
  "## Workflow class",
  DEFAULT_ISSUE_WORKFLOW_CLASS,
  "",
  "## Objective",
  "이 일이 끝났을 때 무엇이 달라져야 하는가",
  "",
  "## Source of truth",
  "Issue / Figma / Confluence / PR / log / file 경로",
  "",
  "## Current state",
  "지금 관찰된 사실",
  "",
  "## Acceptance criteria",
  "완료 판정 기준",
  "",
  "## Required artifacts",
  "context-pack, verification report, risk/rollback note 등",
  "",
  "## Human gate owner",
  "필요한 경우 승인자 또는 reviewer",
].join("\n");
