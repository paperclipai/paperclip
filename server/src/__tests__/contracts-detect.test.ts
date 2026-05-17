import { describe, it, expect } from "vitest";
import { detectContractTypes } from "../contracts/detect.js";
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

function makeComment(body: string, overrides: Partial<CommentForContracts> = {}): CommentForContracts {
  return {
    id: "c-" + Math.random(),
    body,
    authorAgentId: null,
    authorUserId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("detectContractTypes", () => {
  describe("telegram-origin", () => {
    it("detects via [telegram:inbound] marker in comments", () => {
      const issue = makeIssue();
      const comments = [makeComment("[telegram:inbound] user asked something")];
      expect(detectContractTypes(issue, comments)).toContain("telegram-origin");
    });

    it("detects via originKind=interactive with inbound marker", () => {
      const issue = makeIssue({ originKind: "interactive" });
      const comments = [makeComment("[telegram:inbound] hello")];
      expect(detectContractTypes(issue, comments)).toContain("telegram-origin");
    });

    it("does NOT detect without inbound marker when originKind=interactive", () => {
      const issue = makeIssue({ originKind: "interactive" });
      const types = detectContractTypes(issue, []);
      expect(types).not.toContain("telegram-origin");
    });

    it("does NOT detect for normal manual issues", () => {
      const types = detectContractTypes(makeIssue(), []);
      expect(types).not.toContain("telegram-origin");
    });
  });

  describe("bridge-dispatched", () => {
    it("detects via [engineering:dispatch] in description", () => {
      const issue = makeIssue({ description: "This is a [engineering:dispatch] task" });
      expect(detectContractTypes(issue, [])).toContain("bridge-dispatched");
    });

    it("detects via originKind=bridge_dispatch", () => {
      const issue = makeIssue({ originKind: "bridge_dispatch" });
      expect(detectContractTypes(issue, [])).toContain("bridge-dispatched");
    });

    it("does NOT detect without dispatch markers", () => {
      const types = detectContractTypes(makeIssue(), []);
      expect(types).not.toContain("bridge-dispatched");
    });
  });

  describe("code-change", () => {
    it("detects via type/feature label", () => {
      const issue = makeIssue({ labels: [{ name: "type/feature" }] });
      expect(detectContractTypes(issue, [])).toContain("code-change");
    });

    it("detects via type/fix label", () => {
      const issue = makeIssue({ labels: [{ name: "type/fix" }] });
      expect(detectContractTypes(issue, [])).toContain("code-change");
    });

    it("detects via type/refactor label", () => {
      const issue = makeIssue({ labels: [{ name: "type/refactor" }] });
      expect(detectContractTypes(issue, [])).toContain("code-change");
    });

    it("detects via type/test label", () => {
      const issue = makeIssue({ labels: [{ name: "type/test" }] });
      expect(detectContractTypes(issue, [])).toContain("code-change");
    });

    it("does NOT detect for unlabeled issues", () => {
      const types = detectContractTypes(makeIssue(), []);
      expect(types).not.toContain("code-change");
    });

    it("does NOT detect for unrelated labels", () => {
      const issue = makeIssue({ labels: [{ name: "domain/devex" }] });
      const types = detectContractTypes(issue, []);
      expect(types).not.toContain("code-change");
    });
  });

  describe("design-only", () => {
    it("detects via 'Design:' title prefix", () => {
      const issue = makeIssue({ title: "Design: completion contracts" });
      expect(detectContractTypes(issue, [])).toContain("design-only");
    });

    it("detects via kind/design label", () => {
      const issue = makeIssue({ labels: [{ name: "kind/design" }] });
      expect(detectContractTypes(issue, [])).toContain("design-only");
    });

    it("detects via 'Plan only; do not write code' in description", () => {
      const issue = makeIssue({ description: "Plan only; do not write code." });
      expect(detectContractTypes(issue, [])).toContain("design-only");
    });

    it("does NOT detect for regular issues", () => {
      const types = detectContractTypes(makeIssue(), []);
      expect(types).not.toContain("design-only");
    });
  });

  describe("meta-no-artifact", () => {
    it("detects via [EPIC] title prefix", () => {
      const issue = makeIssue({ title: "[EPIC] stability improvements" });
      expect(detectContractTypes(issue, [])).toEqual(["meta-no-artifact"]);
    });

    it("detects via [META] title prefix", () => {
      const issue = makeIssue({ title: "[META] tracker" });
      expect(detectContractTypes(issue, [])).toEqual(["meta-no-artifact"]);
    });

    it("detects via Meta: title prefix", () => {
      const issue = makeIssue({ title: "Meta: platform health" });
      expect(detectContractTypes(issue, [])).toEqual(["meta-no-artifact"]);
    });

    it("is mutually exclusive — overrides other matches", () => {
      const issue = makeIssue({
        title: "[EPIC] something",
        labels: [{ name: "type/feature" }],
        description: "[engineering:dispatch]",
      });
      const types = detectContractTypes(issue, [makeComment("[telegram:inbound] hi")]);
      expect(types).toEqual(["meta-no-artifact"]);
    });

    it("does NOT detect for normal issues", () => {
      const types = detectContractTypes(makeIssue(), []);
      expect(types).not.toContain("meta-no-artifact");
    });
  });

  describe("multi-contract", () => {
    it("returns both telegram-origin and code-change when both match", () => {
      const issue = makeIssue({ labels: [{ name: "type/fix" }] });
      const comments = [makeComment("[telegram:inbound] bug report")];
      const types = detectContractTypes(issue, comments);
      expect(types).toContain("telegram-origin");
      expect(types).toContain("code-change");
    });

    it("returns telegram-origin and bridge-dispatched together", () => {
      const issue = makeIssue({ description: "[engineering:dispatch] via bridge" });
      const comments = [makeComment("[telegram:inbound] dispatched")];
      const types = detectContractTypes(issue, comments);
      expect(types).toContain("telegram-origin");
      expect(types).toContain("bridge-dispatched");
    });
  });
});
