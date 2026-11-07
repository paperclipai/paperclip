import { describe, expect, it, vi } from "vitest";
import { conflict, notFound, unprocessable } from "../errors.js";
import { intakeRoutingActivityDetails, resolveIssueIntakeRouting, type IntakeRoutingDeps, type IntakeRoutingInput } from "./issue-intake-routing.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const INTAKE = "22222222-2222-4222-8222-222222222222";
const BUILDER = "33333333-3333-4333-8333-333333333333";
const PARENT = "44444444-4444-4444-8444-444444444444";

function deps(overrides: Partial<{ intakeAgentId: string | null; eligibilityError: Error }> = {}): IntakeRoutingDeps {
  return {
    getCompanyIntakeAgentId: vi.fn(async () => overrides.intakeAgentId === undefined ? INTAKE : overrides.intakeAgentId),
    assertAssignableAgent: vi.fn(async () => { if (overrides.eligibilityError) throw overrides.eligibilityError; }),
  };
}

function input(overrides: Partial<IntakeRoutingInput> = {}): IntakeRoutingInput {
  return { companyId: COMPANY, actorType: "user", status: "todo", assigneeAgentId: undefined, assigneeUserId: undefined, parentId: null, ...overrides };
}

describe("resolveIssueIntakeRouting", () => {
  it("routes unassigned board work and records no requested assignee", async () => {
    await expect(resolveIssueIntakeRouting(deps(), input())).resolves.toEqual({ intakeAgentId: INTAKE, requestedAssigneeAgentId: null });
  });
  it("keeps an explicit agent assignee on a root board create", async () => {
    const d = deps();
    await expect(resolveIssueIntakeRouting(d, input({ assigneeAgentId: BUILDER, parentId: null }))).resolves.toBeNull();
    expect(d.getCompanyIntakeAgentId).not.toHaveBeenCalled();
  });
  it("keeps an explicit agent assignee on a board child", async () => {
    await expect(resolveIssueIntakeRouting(deps(), input({ assigneeAgentId: BUILDER, parentId: PARENT }))).resolves.toBeNull();
  });
  it("keeps a create already assigned to the intake agent", async () => {
    await expect(resolveIssueIntakeRouting(deps(), input({ assigneeAgentId: INTAKE }))).resolves.toBeNull();
  });
  it("leaves agent, user-assigned, and closed creates untouched", async () => {
    const d = deps();
    await expect(resolveIssueIntakeRouting(d, input({ actorType: "agent" }))).resolves.toBeNull();
    await expect(resolveIssueIntakeRouting(d, input({ assigneeUserId: "user-1" }))).resolves.toBeNull();
    await expect(resolveIssueIntakeRouting(d, input({ status: "done" }))).resolves.toBeNull();
    expect(d.getCompanyIntakeAgentId).not.toHaveBeenCalled();
  });
  it("is disabled when no intake agent is configured", async () => {
    await expect(resolveIssueIntakeRouting(deps({ intakeAgentId: null }), input())).resolves.toBeNull();
  });
  it.each([notFound("missing"), unprocessable("foreign"), conflict("terminated")])("leaves the create unassigned when eligibility refuses: %s", async (error) => {
    await expect(resolveIssueIntakeRouting(deps({ eligibilityError: error }), input())).resolves.toBeNull();
  });
  it("surfaces infrastructure eligibility failures", async () => {
    const error = new Error("database unavailable");
    await expect(resolveIssueIntakeRouting(deps({ eligibilityError: error }), input())).rejects.toBe(error);
  });
});

it("records routing metadata only for a rerouted create", () => {
  expect(intakeRoutingActivityDetails(null)).toEqual({});
  expect(intakeRoutingActivityDetails({ intakeAgentId: INTAKE, requestedAssigneeAgentId: null })).toEqual({ intakeRouted: true, intakeAgentId: INTAKE, requestedAssigneeAgentId: null });
});
