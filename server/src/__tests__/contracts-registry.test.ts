import { describe, it, expect } from "vitest";
import { evaluateContracts } from "../contracts/registry.js";
import type { IssueForContracts, CommentForContracts } from "../contracts/types.js";

function makeIssue(overrides: Partial<IssueForContracts> = {}): IssueForContracts {
  return {
    id: "test-id",
    title: "Some issue",
    description: null,
    originKind: "manual",
    labels: [],
    ...overrides,
  };
}

function makeComment(body: string, createdAt?: Date): CommentForContracts {
  return {
    id: "c-" + Math.random(),
    body,
    authorAgentId: null,
    authorUserId: null,
    createdAt: createdAt ?? new Date(),
  };
}

describe("evaluateContracts", () => {
  describe("no contracts", () => {
    it("returns ok for an issue with no matching contracts", () => {
      const result = evaluateContracts(makeIssue(), []);
      expect(result.ok).toBe(true);
      expect(result.contracts).toEqual([]);
      expect(result.violations).toEqual([]);
    });
  });

  describe("telegram-origin", () => {
    it("passes when [telegram:reply] exists after [telegram:inbound]", () => {
      const t1 = new Date("2024-01-01T10:00:00Z");
      const t2 = new Date("2024-01-01T11:00:00Z");
      const issue = makeIssue();
      const comments = [
        makeComment("[telegram:inbound] user said hi", t1),
        makeComment("[telegram:reply] replied back", t2),
      ];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(true);
    });

    it("fails when [telegram:reply] is BEFORE [telegram:inbound]", () => {
      const t1 = new Date("2024-01-01T10:00:00Z");
      const t2 = new Date("2024-01-01T11:00:00Z");
      const issue = makeIssue();
      const comments = [
        makeComment("[telegram:reply] replied", t1),
        makeComment("[telegram:inbound] new message", t2),
      ];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(false);
      expect(result.violations[0].contract).toBe("telegram-origin");
      expect(result.violations[0].missing).toMatch(/\[telegram:reply\]/);
    });

    it("fails when no [telegram:reply] exists at all", () => {
      const issue = makeIssue();
      const comments = [makeComment("[telegram:inbound] user question")];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(false);
      expect(result.violations[0].contract).toBe("telegram-origin");
    });

    it("handles multiple inbounds — latest must have a reply", () => {
      const t1 = new Date("2024-01-01T10:00:00Z");
      const t2 = new Date("2024-01-01T11:00:00Z");
      const t3 = new Date("2024-01-01T12:00:00Z");
      const issue = makeIssue();
      const comments = [
        makeComment("[telegram:inbound] first", t1),
        makeComment("[telegram:reply] replied to first", t2),
        makeComment("[telegram:inbound] second message", t3),
        // No reply to second inbound
      ];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(false);
      expect(result.violations[0].contract).toBe("telegram-origin");
    });
  });

  describe("bridge-dispatched", () => {
    it("passes when close comment has both required sections", () => {
      const issue = makeIssue({ description: "[engineering:dispatch]" });
      const closeComment = makeComment(
        "Done\n\n## Technical notes\nFixed the issue\n\n## Decisions and outcomes\nResolved via config change",
      );
      const result = evaluateContracts(issue, [closeComment]);
      expect(result.ok).toBe(true);
    });

    it("fails when close comment missing Technical notes section", () => {
      const issue = makeIssue({ description: "[engineering:dispatch]" });
      const closeComment = makeComment("## Decisions and outcomes\nSome decision");
      const result = evaluateContracts(issue, [closeComment]);
      expect(result.ok).toBe(false);
      expect(result.violations[0].missing).toMatch(/Technical notes/);
    });

    it("fails when close comment missing Decisions section", () => {
      const issue = makeIssue({ description: "[engineering:dispatch]" });
      const closeComment = makeComment("## Technical notes\nSome technical info");
      const result = evaluateContracts(issue, [closeComment]);
      expect(result.ok).toBe(false);
      expect(result.violations[0].missing).toMatch(/Decisions and outcomes/);
    });

    it("fails when no comments at all", () => {
      const issue = makeIssue({ description: "[engineering:dispatch]" });
      const result = evaluateContracts(issue, []);
      expect(result.ok).toBe(false);
      expect(result.violations[0].contract).toBe("bridge-dispatched");
    });
  });

  describe("code-change", () => {
    it("passes when PR URL in a comment", () => {
      const issue = makeIssue({ labels: [{ name: "type/feature" }] });
      const comments = [makeComment("PR: https://github.com/org/repo/pull/123")];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(true);
    });

    it("passes when github/pr-merged label present", () => {
      const issue = makeIssue({
        labels: [{ name: "type/fix" }, { name: "github/pr-merged" }],
      });
      const result = evaluateContracts(issue, []);
      expect(result.ok).toBe(true);
    });

    it("passes with no-pr justification comment", () => {
      const issue = makeIssue({ labels: [{ name: "type/refactor" }] });
      const comments = [makeComment("no-pr: revert was done via config change only")];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(true);
    });

    it("fails when no PR URL and no justification", () => {
      const issue = makeIssue({ labels: [{ name: "type/feature" }] });
      const comments = [makeComment("Implemented the feature")];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(false);
      expect(result.violations[0].contract).toBe("code-change");
    });
  });

  describe("design-only", () => {
    it("passes when plan signal and approval signal present", () => {
      const issue = makeIssue({ title: "Design: something" });
      const comments = [
        makeComment("Plan document created: [plan document](/ENG/issues/ENG-57#document-plan)"),
        makeComment("Design approved via self-approve — no PR Reviewer flags"),
      ];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(true);
    });

    it("fails when no plan signal", () => {
      const issue = makeIssue({ title: "Design: something" });
      const comments = [makeComment("Approved!")];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(false);
      expect(result.violations[0].missing).toMatch(/plan document/);
    });

    it("fails when plan exists but no approval", () => {
      const issue = makeIssue({ title: "Design: something" });
      const comments = [makeComment("See #document-plan for the plan")];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(false);
      expect(result.violations[0].missing).toMatch(/approval/);
    });
  });

  describe("meta-no-artifact", () => {
    it("returns ok (children check is server-side enriched)", () => {
      const issue = makeIssue({ title: "[EPIC] platform" });
      const result = evaluateContracts(issue, []);
      expect(result.ok).toBe(true);
      expect(result.contracts).toContain("meta-no-artifact");
    });
  });

  describe("multi-contract", () => {
    it("reports violations from all failing contracts", () => {
      const issue = makeIssue({
        labels: [{ name: "type/fix" }],
        description: "[engineering:dispatch] from bridge",
      });
      const comments = [
        makeComment("[telegram:inbound] user reported bug"),
        // No telegram reply, no PR URL, no bridge sections
        makeComment("Fixed it"),
      ];
      const result = evaluateContracts(issue, comments);
      expect(result.ok).toBe(false);
      const violatedContracts = result.violations.map((v) => v.contract);
      expect(violatedContracts).toContain("telegram-origin");
      expect(violatedContracts).toContain("bridge-dispatched");
      expect(violatedContracts).toContain("code-change");
    });
  });
});
