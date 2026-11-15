import type { toolPolicies } from "@paperclipai/db";

type PolicyValues = Pick<typeof toolPolicies.$inferInsert, "name" | "policyType" | "priority" | "selectors" | "conditions" | "config">;

/**
 * Enabled policies shaped like the staging company whose tools/list profile
 * showed policy matching on the main thread: 363 policies, of which 342 select
 * only a catalog entry, 18 a catalog entry and its connection, 3 several other
 * keys, and 17 carry conditions. 359 require approval, 3 are trust rules and 1
 * blocks.
 */
export function stagingShapedToolPolicies(input: {
  catalogEntries: ReadonlyArray<{ id: string; connectionId: string | null; toolName: string | null }>;
  agentId: string;
  projectId: string;
  applicationId: string;
  connectionId: string;
}): PolicyValues[] {
  const { catalogEntries } = input;
  if (catalogEntries.length === 0) throw new Error("At least one catalog entry is required");
  const entry = (index: number) => catalogEntries[index % catalogEntries.length]!;
  const conditionShapes: Array<Record<string, unknown>> = [
    { risk: { isWrite: true } },
    { arguments: { fieldExists: ["query"] } },
    { context: { requireIssue: true } },
    { timeWindow: { daysOfWeekUtc: [0, 1, 2, 3, 4, 5, 6] } },
  ];
  const policies: PolicyValues[] = [];
  for (let index = 0; index < 342; index += 1) {
    policies.push({
      name: `Ask first ${index}`,
      policyType: "require_approval",
      priority: 100,
      selectors: { catalogEntryId: entry(index).id },
      conditions: index < 17 ? conditionShapes[index % conditionShapes.length]! : null,
      config: { source: "connection_intent" },
    });
  }
  for (let index = 0; index < 18; index += 1) {
    const selected = entry(342 + index);
    policies.push({
      name: `Ask first on connection ${index}`,
      policyType: "require_approval",
      priority: 100,
      selectors: { catalogEntryId: selected.id, connectionId: selected.connectionId ?? input.connectionId },
      conditions: null,
      config: null,
    });
  }
  const trustedTool = entry(0).toolName ?? "tool";
  policies.push(
    {
      name: "Trusted for agent",
      policyType: "trust_rule",
      priority: 50,
      selectors: { agentId: input.agentId, applicationId: input.applicationId, connectionId: input.connectionId, toolName: trustedTool },
      conditions: null,
      config: { trustRule: { argumentFilters: { fieldEquals: { query: "status" } }, approvalThreshold: 3 } },
    },
    {
      name: "Trusted in project",
      policyType: "trust_rule",
      priority: 50,
      selectors: { projectId: input.projectId, connectionId: input.connectionId, toolName: trustedTool },
      conditions: null,
      config: { trustRule: { argumentFilters: { fieldEquals: { query: "list" } }, approvalThreshold: 3 } },
    },
    {
      name: "Trusted on application",
      policyType: "trust_rule",
      priority: 50,
      selectors: { applicationId: input.applicationId, agentId: input.agentId, toolName: entry(1).toolName ?? "tool" },
      conditions: null,
      config: { trustRule: { argumentFilters: { fieldEquals: { query: "read" } }, approvalThreshold: 3 } },
    },
  );
  // The block replaces one ask-first selector so the counts stay at 363.
  policies[341] = {
    name: "Block one action",
    policyType: "block",
    priority: 10,
    selectors: { catalogEntryId: entry(341).id },
    conditions: null,
    config: null,
  };
  return policies;
}
