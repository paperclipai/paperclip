import { describe, expect, it } from "vitest";
import {
  getDefaultHltUseCase,
  getHltUseCaseStarterExamples,
  HLT_USE_CASE_CATALOG,
} from "./hlt-use-case-catalog";

describe("HLT use-case starter catalog", () => {
  it("starts with the article drafting workflow", () => {
    const defaultUseCase = getDefaultHltUseCase();

    expect(defaultUseCase.id).toBe("draft-review-hlt-article");
    expect(defaultUseCase.label).toBe("Draft and review an HLT article");
    expect(defaultUseCase.defaultTaskDescription).toContain("stop before publish");
  });

  it("contains the required HLT starter cards", () => {
    expect(HLT_USE_CASE_CATALOG.map((useCase) => useCase.id)).toEqual([
      "draft-review-hlt-article",
      "find-article-opportunities",
      "qbank-powered-content",
      "improve-katailyst-skill",
      "compare-two-versions",
      "polish-nurse-jobs-outreach",
      "make-ad-media-concepts",
      "find-what-needs-fixing",
    ]);
  });

  it("keeps raw Katailyst plumbing out of visible starter copy", () => {
    const visibleCopy = HLT_USE_CASE_CATALOG.map((useCase) => [
      useCase.label,
      useCase.shortDescription,
      ...useCase.outcomeBullets,
      useCase.approvalBoundary ?? "",
      useCase.fallbackBehavior,
      useCase.defaultTaskTitle,
      useCase.defaultTaskDescription,
    ].join("\n")).join("\n\n");

    expect(visibleCopy).not.toMatch(/Katailyst/i);
    expect(visibleCopy).not.toMatch(/schema:/i);
    expect(visibleCopy).not.toMatch(/tool:/i);
    expect(visibleCopy).not.toMatch(/katailyst\.create_/i);
    expect(visibleCopy).not.toMatch(/registry\.search/i);
  });

  it("keeps Katailyst refs as hidden metadata", () => {
    const article = getDefaultHltUseCase();

    expect(article.optionalKatailystRefs).toContain("playbook:make-article");
    expect(article.optionalKatailystRefs).toContain("schema:article_v2");
  });

  it("makes the nurse recruiting consent boundary visible", () => {
    const recruiting = HLT_USE_CASE_CATALOG.find(
      (useCase) => useCase.id === "polish-nurse-jobs-outreach",
    );

    expect(recruiting).toBeDefined();
    expect(recruiting?.approvalBoundary).toMatch(/opted-in career users/i);
    expect(recruiting?.defaultTaskDescription).toMatch(/explicit consent/i);
  });

  it("maps catalog cards to onboarding starter examples", () => {
    const examples = getHltUseCaseStarterExamples();

    expect(examples).toHaveLength(HLT_USE_CASE_CATALOG.length);
    expect(examples[0]).toMatchObject({
      label: "Article draft",
      title: "Draft and review an HLT article",
    });
    expect(examples[0].description).toContain("clear, source-grounded draft");
  });
});
