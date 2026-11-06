import { describe, expect, it } from "vitest";
import { companySearchQuerySchema } from "@paperclipai/shared";
import { compileDescription } from "../services/status-cards.js";

type CompileCard = Parameters<typeof compileDescription>[0];

const card = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  interestPrompt: "Blocked launch work updated this week",
} as CompileCard;

describe("status-card compile prompt", () => {
  const description = compileDescription(card, "33333333-3333-4333-8333-333333333333", "hash");

  // The compile task can be assigned to any summarizer agent (built-in or a
  // per-card override), and no skill is provisioned for it. Pointing the run at
  // a skill it cannot read made weaker models spend the whole run searching
  // for it instead of writing the query.
  it("does not depend on a skill the summarizer run is not given", () => {
    expect(description).not.toContain("status-card-query");
    expect(description).not.toMatch(/\buse the [^.\n]*\bskill\b/i);
  });

  it("inlines the query format and the full write-back sequence", () => {
    for (const field of ["scope", "q", "status", "priority", "assigneeAgentId", "projectId", "labelId", "updatedWithin", "sort", "limit", "offset"]) {
      expect(description).toContain(`\`${field}\``);
    }
    expect(description).toContain(`GET /api/companies/${card.companyId}/projects`);
    expect(description).toContain(`GET /api/companies/${card.companyId}/labels`);
    expect(description).toContain(`PUT /api/status-cards/${card.id}/query`);
    expect(description).toContain(`GET /api/status-cards/${card.id}/dry-run`);
    expect(description).toContain(`PUT /api/status-cards/${card.id}/summary`);
  });

  it("keeps the example query valid and the generation payload parseable", () => {
    const example = description.match(/```text\n([\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();
    const body = JSON.parse(example!) as { queries: unknown[] };
    for (const query of body.queries) {
      expect(companySearchQuerySchema.safeParse(query).success).toBe(true);
    }
    const payload = description.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(JSON.parse(payload!)).toMatchObject({ operation: "compile", statusCardId: card.id });
  });
});
