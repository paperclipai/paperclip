import { describe, expect, it } from "vitest";
import { HLT_ARTICLE_FACTORY_TEMPLATE } from "../routes/team-templates.js";

const FORBIDDEN_HUMAN_LABELS = [
  /operational_log/i,
  /schema:/i,
  /kb:/i,
  /\bHIG-\d+/i,
  /disposition/i,
  /liveness/i,
];

describe("HLT team templates", () => {
  it("keeps the Article Factory import human-readable", () => {
    const chunks = [
      HLT_ARTICLE_FACTORY_TEMPLATE.name,
      HLT_ARTICLE_FACTORY_TEMPLATE.summary,
      HLT_ARTICLE_FACTORY_TEMPLATE.goal.title,
      HLT_ARTICLE_FACTORY_TEMPLATE.project.name,
      ...HLT_ARTICLE_FACTORY_TEMPLATE.agents.flatMap((agent) => [
        agent.name,
        agent.title,
        agent.capabilities,
      ]),
      ...HLT_ARTICLE_FACTORY_TEMPLATE.issues.flatMap((issue) => [issue.title, issue.description]),
    ];

    for (const chunk of chunks) {
      expect(chunk).toBeTruthy();
      for (const forbidden of FORBIDDEN_HUMAN_LABELS) {
        expect(chunk).not.toMatch(forbidden);
      }
    }
  });

  it("requires every starter work item to show a readable deliverable", () => {
    expect(HLT_ARTICLE_FACTORY_TEMPLATE.issues.length).toBeGreaterThan(0);
    for (const issue of HLT_ARTICLE_FACTORY_TEMPLATE.issues) {
      expect(issue.description).toContain("save the actual readable deliverable");
      expect(issue.description).toContain("Paperclip issue document");
    }
  });

  it("includes Victoria as the quality review lane before publishing", () => {
    const victoria = HLT_ARTICLE_FACTORY_TEMPLATE.agents.find((agent) => agent.name === "Victoria Review");
    expect(victoria).toMatchObject({
      title: "Victoria Quality Reviewer",
      profile: "victoria",
      reportsTo: "Article Lead",
    });
    expect(victoria?.capabilities).toContain("research-first");
    expect(victoria?.capabilities).toContain("evidence-grounded");

    const reviewTask = HLT_ARTICLE_FACTORY_TEMPLATE.issues.find((issue) => issue.assignee === "Victoria Review");
    expect(reviewTask?.title).toBe("Run Victoria quality review before publishing");
    expect(reviewTask?.description).toContain("before any publishing step");
    expect(reviewTask?.description).toContain("strengths, risks, and exact revision requests");

    const mediaIndex = HLT_ARTICLE_FACTORY_TEMPLATE.issues.findIndex((issue) => issue.assignee === "Media Producer");
    const victoriaIndex = HLT_ARTICLE_FACTORY_TEMPLATE.issues.findIndex((issue) => issue.assignee === "Victoria Review");
    expect(mediaIndex).toBeGreaterThanOrEqual(0);
    expect(victoriaIndex).toBeGreaterThan(mediaIndex);
  });

  it("carries Hermes, Paperclip, and Katailyst source grounding into imports", () => {
    expect(HLT_ARTICLE_FACTORY_TEMPLATE.sourceRefs).toEqual(expect.arrayContaining([
      "agent:victoria@v1",
      "kb:hlt-app-paperclip@v1",
      "playbook:make-article@v1",
      "rubric:article-quality-v1@v1",
    ]));
    expect(HLT_ARTICLE_FACTORY_TEMPLATE.bestPractices.join(" ")).toContain("Paperclip is the control plane");
    expect(HLT_ARTICLE_FACTORY_TEMPLATE.bestPractices.join(" ")).toContain("Hermes works best");
    expect(HLT_ARTICLE_FACTORY_TEMPLATE.bestPractices.join(" ")).toContain("Victoria provides the article-quality review lane");
  });
});
