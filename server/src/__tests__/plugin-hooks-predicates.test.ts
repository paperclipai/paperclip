import { describe, expect, it } from "vitest";
import { evaluateWhen } from "../services/plugin-hooks/predicates.js";
import type { PluginHookIssueContext } from "../services/plugin-hooks/types.js";

const issue: PluginHookIssueContext = {
  issueId: "issue-1",
  companyId: "company-1",
  projectId: "project-1",
  assigneeAgentId: "agent-1",
  fields: {
    fastAction: true,
    priority: "high",
    label: null,
  },
};

describe("evaluateWhen", () => {
  it("returns true when no predicate is provided", () => {
    expect(evaluateWhen(null, { issue })).toBe(true);
    expect(evaluateWhen(undefined, { issue })).toBe(true);
  });

  it("matches issueHasField only when the field is present", () => {
    expect(evaluateWhen({ issueHasField: "fastAction" }, { issue })).toBe(true);
    expect(evaluateWhen({ issueHasField: "missing" }, { issue })).toBe(false);
  });

  it("matches issueFieldEquals strictly on scalars", () => {
    expect(
      evaluateWhen({ issueFieldEquals: { field: "fastAction", value: true } }, { issue }),
    ).toBe(true);
    expect(
      evaluateWhen({ issueFieldEquals: { field: "fastAction", value: false } }, { issue }),
    ).toBe(false);
    expect(
      evaluateWhen({ issueFieldEquals: { field: "priority", value: "high" } }, { issue }),
    ).toBe(true);
  });

  it("matches null values explicitly", () => {
    expect(
      evaluateWhen({ issueFieldEquals: { field: "label", value: null } }, { issue }),
    ).toBe(true);
  });

  it("evaluates agentRoleEquals against the supplied role", () => {
    expect(
      evaluateWhen({ agentRoleEquals: "founding_engineer" }, {
        issue,
        agentRole: "founding_engineer",
      }),
    ).toBe(true);
    expect(
      evaluateWhen({ agentRoleEquals: "founding_engineer" }, { issue, agentRole: "ceo" }),
    ).toBe(false);
    expect(
      evaluateWhen({ agentRoleEquals: "founding_engineer" }, { issue }),
    ).toBe(false);
  });

  it("supports composite predicates", () => {
    expect(
      evaluateWhen(
        {
          all: [
            { issueHasField: "fastAction" },
            { issueFieldEquals: { field: "priority", value: "high" } },
          ],
        },
        { issue },
      ),
    ).toBe(true);
    expect(
      evaluateWhen(
        {
          any: [
            { issueFieldEquals: { field: "priority", value: "low" } },
            { issueFieldEquals: { field: "priority", value: "high" } },
          ],
        },
        { issue },
      ),
    ).toBe(true);
    expect(
      evaluateWhen(
        { not: { issueFieldEquals: { field: "fastAction", value: false } } },
        { issue },
      ),
    ).toBe(true);
  });

  it("treats malformed predicates as non-matches (fail-closed)", () => {
    expect(evaluateWhen({} as never, { issue })).toBe(false);
    expect(evaluateWhen({ issueHasField: 5 } as never, { issue })).toBe(false);
    expect(evaluateWhen({ issueFieldEquals: {} } as never, { issue })).toBe(false);
    expect(evaluateWhen("nope" as never, { issue })).toBe(false);
  });

  it("caps recursion depth", () => {
    let nested: unknown = { issueHasField: "fastAction" };
    for (let i = 0; i < 64; i += 1) nested = { not: nested };
    expect(evaluateWhen(nested as never, { issue })).toBe(false);
  });
});
