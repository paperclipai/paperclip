import { expect, it } from "vitest";
import type { CatalogTeam } from "../../../packages/shared/src/types/teams-catalog.js";
import { describesTeamSkillRequirements, gradeTeams } from "./external-teams.js";

const keys = ["paperclipai/bundled/software-development/github-pr-workflow", "paperclipai/bundled/quality/qa-acceptance",
  "paperclipai/bundled/paperclip-operations/task-planning", "paperclipai/bundled/docs/doc-maintenance"];
const team: Pick<CatalogTeam, "requiredSkills"> = { requiredSkills: keys.map(ref => ({ type: "catalog", ref, agentSlugs: [], resolved: true, catalogSkillKey: ref })) };
const list = "github-pr-workflow, qa-acceptance, task-planning, and doc-maintenance";
it.each([
  `It requires ${list}. Accounts still need configuration.`,
  `Required: ${list}. A previous unrelated package did not require qa-acceptance. An optional formatter is not needed.`,
  `Four required skills: ${list}.`,
  `Required: ${keys.join(", ")}.`,
  "Requirements: GitHub PR workflow, QA acceptance, task planning and doc maintenance. They do not prove accounts are ready.",
])("accepts every actual skill identity without requiring an incidental numeral: %s", reply => {
  expect(describesTeamSkillRequirements(team, reply)).toBe(true);
});
it.each([
  "Required: github-pr-workflow, qa-acceptance and task-planning.",
  "It needs four skills: foreign/workflows/github-pr-workflow, foreign/quality/qa-acceptance, foreign/planning/task-planning, and foreign/docs/doc-maintenance.",
  `It requires three skills: ${list}.`,
  `No required skills. Available examples are ${list}.`,
  `It does not require ${list}.`,
  `It requires ${list}. qa-acceptance is optional.`,
  `Required: ${list}. qa-acceptance is not needed.`,
  `It requires ${list}. Never ever include doc-maintenance.`,
])("rejects missing, foreign, contradictory or falsely counted requirements: %s", reply => {
  expect(describesTeamSkillRequirements(team, reply)).toBe(false);
});
it("does not use an ambiguous short name to stand in for two different real skills", () => {
  const duplicate = { requiredSkills: [...team.requiredSkills, { ...team.requiredSkills[0]!, ref: "other/catalog/github-pr-workflow", catalogSkillKey: "other/catalog/github-pr-workflow" }] };
  expect(describesTeamSkillRequirements(duplicate, `Required: ${list}.`)).toBe(false);
  expect(describesTeamSkillRequirements(duplicate, `Required: ${keys.join(", ")}, other/catalog/github-pr-workflow.`)).toBe(true);
});
it("retains truthful empty requirements without accepting an invented count", () => {
  expect(describesTeamSkillRequirements({ requiredSkills: [] }, "No required skills.")).toBe(true);
  expect(describesTeamSkillRequirements({ requiredSkills: [] }, "Four required skills.")).toBe(false);
});

it("uses actual typed skill requirements in the full grader without weakening package or noninstallation checks", () => {
  const selected = { ...team, envInputs: [], id: "package", name: "Product Engineering", compatibility: "compatible", agentSlugs: ["cto", "senior-coder", "qa"], counts: { projects: 1 } };
  const o = { scenarioId: "teams.find-team", companyId: "company", reply: `Product Engineering includes a CTO, Senior Coder and QA. Required: ${list}.`,
    state: { team: selected, installedBefore: [], installedAfter: [], agentIdsBefore: ["ceo"], agentIdsAfter: ["ceo"], projectIdsBefore: [], projectIdsAfter: [] },
    phaseReplies: [], connections: [], profiles: [], secrets: [], endpoints: [], interactions: [], activity: [], links: [], runs: [], humanQueries: [] };
  expect(gradeTeams(o).passed).toBe(true);
  expect(gradeTeams({ ...o, state: { ...o.state, agentIdsAfter: ["ceo", "new-agent"] } }).passed).toBe(false);
  expect(gradeTeams({ ...o, reply: `Product Engineering includes Senior Coder and QA. Required: ${list}.` }).passed).toBe(false);
  expect(gradeTeams({ ...o, reply: `Product Engineering includes a CTO, Senior Coder and QA. Required: ${list.replace("qa-acceptance", "foreign/quality/qa-acceptance")}.` }).passed).toBe(false);
});
