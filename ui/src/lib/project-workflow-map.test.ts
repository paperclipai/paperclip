import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { isSystemRecoveryIssue, workflowPhaseForIssue } from "./project-workflow-map";

describe("project workflow map helpers", () => {
  it("classifies workflow phases by title before description", () => {
    expect(
      workflowPhaseForIssue({
        title: "測試檢查: Virtual Office Sandbox Workflow E2E",
        description: "檢查成果是否符合需求，列出問題與驗收建議。",
      }).id,
    ).toBe("test");

    expect(
      workflowPhaseForIssue({
        title: "覆盤紀錄: Virtual Office Sandbox Workflow E2E",
        description: "整理討論過程、決策理由、完成項目和下一步。",
      }).id,
    ).toBe("retro");
  });

  it("detects system recovery issues", () => {
    expect(isSystemRecoveryIssue({ title: "Recover stalled issue AI-52837", originKind: "manual" })).toBe(true);
    expect(
      isSystemRecoveryIssue({
        title: "需求整理: Sandbox",
        originKind: "stranded_issue_recovery" as Issue["originKind"],
      }),
    ).toBe(true);
    expect(isSystemRecoveryIssue({ title: "需求整理: Sandbox", originKind: "manual" })).toBe(false);
  });
});
