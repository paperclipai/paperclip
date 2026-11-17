import { expect, it } from "vitest";
import { createIssueSchema } from "../../../packages/shared/src/validators/issue.js";
import { inboxTriageControlTaskSeeds } from "./internal-inbox-triage.js";
import { openInventoryTaskSeed } from "./internal-task-inventory.js";
const projectId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const secondWorkerId = "33333333-3333-4333-8333-333333333333";
const personId = "real-authenticated-fixture-person";
it("gives the retained active inbox control its real human owner without changing statuses", () => {
  const seeds = inboxTriageControlTaskSeeds(personId).map(seed => createIssueSchema.parse({ ...seed, projectId }));
  expect(seeds.map(seed => seed.status)).toEqual(["cancelled", "in_progress", "in_review", "backlog"]);
  const active = seeds.find(seed => seed.status === "in_progress")!;
  expect(active.assigneeUserId).toBe(personId);
  expect(active.assigneeAgentId).toBeUndefined();
  expect(seeds.filter(seed => seed.status !== "in_progress").every(seed => !seed.assigneeAgentId && !seed.assigneeUserId)).toBe(true);
});
it("keeps all 501 inventory rows valid with both owners and genuine unassigned Todo work", () => {
  const seeds = Array.from({ length: 501 }, (_, index) => createIssueSchema.parse({ ...openInventoryTaskSeed(index, workerId, secondWorkerId), projectId }));
  expect(new Set(seeds.map(seed => seed.title)).size).toBe(501);
  expect(seeds.filter(seed => seed.status === "in_progress").every(seed => [workerId, secondWorkerId].includes(seed.assigneeAgentId!))).toBe(true);
  expect(seeds.filter(seed => !seed.assigneeAgentId).length).toBe(167);
  expect(seeds.some(seed => !seed.assigneeAgentId && seed.status === "todo")).toBe(true);
  expect(seeds.some(seed => !seed.assigneeAgentId && seed.status === "blocked")).toBe(true);
  for (const owner of [workerId, secondWorkerId]) for (const status of ["blocked", "in_progress", "todo"])
    expect(seeds.some(seed => seed.assigneeAgentId === owner && seed.status === status)).toBe(true);
});
