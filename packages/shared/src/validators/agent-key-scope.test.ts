import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentApiKeyScopeSchema, createAgentKeySchema } from "../index.js";

describe("intake receiver agent API key scope", () => {
  it("accepts one fixed project, assignee, and priority mapping", () => {
    const projectId = randomUUID();
    const assigneeAgentId = randomUUID();

    expect(createAgentKeySchema.parse({
      name: "staging uptime intake",
      scope: {
        kind: "intake_receiver",
        projectId,
        assigneeAgentId,
        priority: "medium",
      },
    }).scope).toEqual({
      kind: "intake_receiver",
      projectId,
      assigneeAgentId,
      priority: "medium",
    });
  });

  it.each([
    { kind: "intake_receiver", assigneeAgentId: randomUUID(), priority: "medium" },
    { kind: "intake_receiver", projectId: randomUUID(), priority: "medium" },
    { kind: "intake_receiver", projectId: randomUUID(), assigneeAgentId: randomUUID() },
    {
      kind: "intake_receiver",
      projectId: randomUUID(),
      assigneeAgentId: randomUUID(),
      priority: "critical",
      projectIds: [randomUUID()],
    },
  ])("rejects incomplete or mutable receiver scope %#", (scope) => {
    expect(agentApiKeyScopeSchema.safeParse(scope).success).toBe(false);
  });
});
