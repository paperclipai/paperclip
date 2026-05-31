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
});
