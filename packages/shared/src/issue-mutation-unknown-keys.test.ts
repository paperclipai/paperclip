import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAcceptedPlanDecompositionSchema,
  createChildIssueSchema,
  createIssueInputSchema,
  createIssueSchema,
  createIssueThreadInteractionSchema,
  updateIssueSchema,
} from "./validators/issue.js";

/** Returns the keys that one parse rejected, or an empty array on success. */
function unrecognizedKeys(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys : [],
  );
}

const VALID_CREATE = { title: "Ship the fix", status: "todo" } as const;

const VALID_INTERACTION = {
  kind: "request_confirmation",
  payload: { version: 1, prompt: "Proceed?" },
} as const;

describe("issue mutation bodies reject an unknown key", () => {
  it("rejects an unknown key on a create-issue body", () => {
    expect(
      unrecognizedKeys(createIssueSchema, {
        ...VALID_CREATE,
        blockedOwnerNotifiedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual(["blockedOwnerNotifiedAt"]);
  });

  it("rejects an unknown key on a patch-issue body", () => {
    expect(
      unrecognizedKeys(updateIssueSchema, {
        status: "blocked",
        blockedOwnerNotifiedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual(["blockedOwnerNotifiedAt"]);
  });

  it("rejects an unknown key on a create-child-issue body", () => {
    expect(
      unrecognizedKeys(createChildIssueSchema, {
        ...VALID_CREATE,
        blockParentUntilDOne: true,
      }),
    ).toEqual(["blockParentUntilDOne"]);
  });

  it("rejects an unknown key on an accepted-plan decomposition body", () => {
    expect(
      unrecognizedKeys(createAcceptedPlanDecompositionSchema, {
        acceptedPlanRevisionId: "0b3ad2f3-1f2c-4d0e-9a5a-6b2a1f0c9d11",
        children: [VALID_CREATE],
        childIssues: [],
      }),
    ).toEqual(["childIssues"]);
  });

  it("rejects an unknown key on a create-interaction body", () => {
    expect(
      unrecognizedKeys(createIssueThreadInteractionSchema, {
        ...VALID_INTERACTION,
        requestedResolverPolicy: "human_only",
      }),
    ).toEqual(["requestedResolverPolicy"]);
  });

  it("rejects an unknown key on the MCP create-issue input body", () => {
    expect(
      unrecognizedKeys(createIssueInputSchema, {
        ...VALID_CREATE,
        assigneeAgent: "0b3ad2f3-1f2c-4d0e-9a5a-6b2a1f0c9d11",
      }),
    ).toEqual(["assigneeAgent"]);
  });

  it("names every unknown key in one error", () => {
    expect(
      unrecognizedKeys(updateIssueSchema, {
        status: "todo",
        firstUnknown: 1,
        secondUnknown: 2,
      }),
    ).toEqual(["firstUnknown", "secondUnknown"]);
  });

  it("reports the rejection as an unrecognized_keys issue at the body root", () => {
    const result = updateIssueSchema.safeParse({ notAField: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["notAField"],
        path: [],
      }),
    ]);
  });
});

describe("issue mutation bodies still accept a known key", () => {
  it("parses a create-issue body and keeps the status default", () => {
    const parsed = createIssueSchema.parse({ title: "Ship the fix" });
    expect(parsed).toMatchObject({ title: "Ship the fix", status: "backlog" });
  });

  it("parses a patch-issue body without adding an absent key", () => {
    const parsed = updateIssueSchema.parse({
      status: "in_progress",
      comment: "Picked this up.",
    });
    expect(parsed).toEqual({ status: "in_progress", comment: "Picked this up." });
  });

  it("parses a nested execution workspace settings object", () => {
    const parsed = updateIssueSchema.parse({
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    expect(parsed.executionWorkspaceSettings).toMatchObject({
      mode: "isolated_workspace",
    });
  });

  it("parses an accepted-plan decomposition body", () => {
    const parsed = createAcceptedPlanDecompositionSchema.parse({
      acceptedPlanRevisionId: "0b3ad2f3-1f2c-4d0e-9a5a-6b2a1f0c9d11",
      children: [{ title: "First child" }],
    });
    expect(parsed.children).toHaveLength(1);
  });
});

describe("the discriminated interaction union still parses each member", () => {
  const MEMBERS = [
    {
      kind: "suggest_tasks",
      payload: {
        version: 1,
        tasks: [{ clientKey: "one", title: "Draft the plan" }],
      },
    },
    {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [
          {
            id: "branch",
            prompt: "Which branch?",
            selectionMode: "single",
            options: [{ id: "master", label: "master" }],
          },
        ],
      },
    },
    { kind: "request_confirmation", payload: { version: 1, prompt: "Proceed?" } },
    {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Pick the targets.",
        options: [{ id: "one", label: "Server" }],
      },
    },
    {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review each finding.",
        items: [{ id: "one", label: "Finding one" }],
        verdicts: ["approve", "reject"],
      },
    },
  ] as const;

  it.each(MEMBERS)("parses a $kind body", (member) => {
    const parsed = createIssueThreadInteractionSchema.parse(member);
    expect(parsed.kind).toBe(member.kind);
  });

  it.each(MEMBERS)("rejects an unknown key on a $kind body", (member) => {
    expect(
      unrecognizedKeys(createIssueThreadInteractionSchema, {
        ...member,
        resolverPolicyOverride: "human_only",
      }),
    ).toEqual(["resolverPolicyOverride"]);
  });

  it("keeps reporting an unknown discriminator value, not an unknown key", () => {
    const result = createIssueThreadInteractionSchema.safeParse({
      kind: "not_a_kind",
      payload: { version: 1 },
    });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) => issue.code === "unrecognized_keys"),
    ).toBe(false);
  });
});
