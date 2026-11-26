import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { contextIntegrityScenario, PAPERCLIP_DOCUMENT_CASE } from "./context-integrity-cases.js";
import { gradeContextIntegrity, type ContextIntegrityCheckpoint } from "./context-integrity-scoring.js";

function recording() {
  const scenario = contextIntegrityScenario(PAPERCLIP_DOCUMENT_CASE, "probe");
  const initial: ContextIntegrityCheckpoint = {
    phase: "initial", issue: { id: "issue", identifier: "DOC-1", issuePrefix: "DOC", appOrigin: "https://paperclip.example", status: "in_progress" },
    documents: [], comments: [], runs: [{ id: "run", status: "running" }],
    assignedSkill: { key: scenario.skillKey, runtimeName: scenario.skillKey, versionId: "version", markdown: `Write ${scenario.marker}` },
    skillRequestText: `${scenario.prompt}\nUse /${scenario.skillKey}`,
  };
  const final: ContextIntegrityCheckpoint = {
    ...initial, phase: "final", issue: { ...initial.issue, status: "done" },
    documents: [{ key: "report", body: `Requested ${scenario.marker}`, latestRevisionId: "revision", latestRevisionNumber: 1 }],
    comments: [{ authorAgentId: "agent", body: "Saved [report](/DOC/issues/DOC-1#document-report)." }],
    runs: [{ id: "run", status: "succeeded" }],
  };
  return { scenario, initial, final };
}

describe("explicit Paperclip document delivery", () => {
  it("checks the actual saved content, revision and exact document link", () => {
    const { scenario, initial, final } = recording();
    expect(gradeContextIntegrity({ ...scenario, checkpoints: [initial, final] }).every(row => row.passed)).toBe(true);
    expect(scenario.prompt).toContain("Paperclip document");
    expect(scenario.prompt).toContain("clickable Markdown link");
    expect(scenario.prompt).toContain("Paperclip task UI");
    expect(scenario.prompt).not.toContain(scenario.marker);
  });
  it.each(["https://paperclip.example/DOC/issues/DOC-1#document-report", "<https://paperclip.example/DOC/issues/DOC-1#document-report>"])("accepts the same-app document link %s", target => {
    const { scenario, initial, final } = recording();
    final.comments[0]!.body = `Saved [report](${target}).`;
    expect(gradeContextIntegrity({ ...scenario, checkpoints: [initial, final] }).every(row => row.passed)).toBe(true);
  });
  it.each(["local-only", "missing-revision", "wrong-content", "local-link", "wrong-document-link", "wrong-company-link", "other-app-link", "user-link-only", "bare-path", "code-formatted-path"])(
    "rejects plausible %s delivery", variant => {
      const { scenario, initial, final } = recording();
      if (variant === "local-only") { final.documents = []; final.comments[0]!.body = "Saved report.md in the workspace."; }
      if (variant === "missing-revision") final.documents[0]!.latestRevisionId = null;
      if (variant === "wrong-content") final.documents[0]!.body = "A different report";
      if (variant === "bare-path") final.comments[0]!.body = "Saved /DOC/issues/DOC-1#document-report.";
      if (variant === "code-formatted-path") final.comments[0]!.body = "Saved `/DOC/issues/DOC-1#document-report`.";
      if (variant === "local-link") final.comments[0]!.body = "Saved [report](./report.md).";
      if (variant === "wrong-document-link") final.comments[0]!.body = "Saved [report](/DOC/issues/DOC-1#document-other).";
      if (variant === "wrong-company-link") final.comments[0]!.body = "Saved [report](/PAP/issues/DOC-1#document-report).";
      if (variant === "other-app-link") final.comments[0]!.body = "Saved [report](https://other.example/DOC/issues/DOC-1#document-report).";
      if (variant === "user-link-only") { delete final.comments[0]!.authorAgentId; final.comments[0]!.authorUserId = "user"; }
      expect(gradeContextIntegrity({ ...scenario, checkpoints: [initial, final] }).some(row => !row.passed)).toBe(true);
    },
  );
  it.each([
    { identifier: "ACME-17", issuePrefix: "ACME", key: "report" },
    { identifier: "TEAM-902", issuePrefix: "TEAM", key: "report-agent-redirected" },
  ])("the shipped recipe delivers the current $identifier and returned $key", ({ identifier, issuePrefix, key }) => {
    const reference = readFileSync(new URL("../../skills/paperclip/references/issue-documents.md", import.meta.url), "utf8");
    const recipe = reference.match(/```javascript\n([\s\S]*?)```/)?.[1];
    expect(recipe).toBeDefined();
    const { scenario, initial, final } = recording();
    initial.issue = { ...initial.issue, identifier, issuePrefix };
    final.issue = { ...final.issue, identifier, issuePrefix };
    final.documents[0]!.key = key;
    final.comments[0]!.body = runInNewContext(`${recipe}\ncomment`, {
      issue: { identifier }, saved: { key },
    }) as string;
    expect(gradeContextIntegrity({ ...scenario, checkpoints: [initial, final] }).every(row => row.passed)).toBe(true);
  });
  it.each([null, undefined])("the shipped recipe supports an unnumbered issue with identifier %s", identifier => {
    const reference = readFileSync(new URL("../../skills/paperclip/references/issue-documents.md", import.meta.url), "utf8");
    const recipe = reference.match(/```javascript\n([\s\S]*?)```/)?.[1];
    expect(recipe).toBeDefined();
    const comment = runInNewContext(`${recipe}\ncomment`, {
      issue: { id: "849c6474-ab4e-4428-981a-0b9a0207fa9b", identifier },
      saved: { key: "report-agent-redirected" },
    }) as string;
    const target = comment.match(/\]\(([^)]+)\)/)?.[1];
    expect(target).toBeDefined();
    const url = new URL(target!, "https://paperclip.example");
    expect(url.pathname).toBe("/issues/849c6474-ab4e-4428-981a-0b9a0207fa9b");
    expect(url.hash).toBe("#document-report-agent-redirected");
  });
  it("preserves the original ambiguous request and assigned output procedure", () => {
    expect(contextIntegrityScenario("assigned-skill-explicit-invocation", "probe").prompt).toBe(
      "Use the assigned Context integrity output skill for this task, then follow its instructions and finish the task. Do not create child tasks or unrelated deliverables.",
    );
  });
});
