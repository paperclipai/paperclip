import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, toolPolicies, type Db as DbClient } from "@paperclipai/db";
import { toolPolicyConditionsSchema, type ToolAccessDecisionInput } from "@paperclipai/shared";
import {
  createToolAccessDecisionCache,
  evaluatePolicyConditions,
  indexEnabledToolPolicies,
  matchEnabledToolPolicies,
  policyConditions,
  selectorMatches,
  toolAccessPolicyService,
  type EnabledToolPolicyMatch,
  type ToolAccessContext,
} from "../services/tool-access-policy.js";
import { compilePolicySelector } from "../services/tool-access/policy-selector-index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createListingFixture } from "./helpers/tool-gateway-listing-fixture.js";
import { stagingShapedToolPolicies } from "./helpers/tool-policy-index-fixture.js";

type PolicyRow = typeof toolPolicies.$inferSelect;

/** The unindexed matching that decisions used before the policy index. */
function unindexedMatch(policies: PolicyRow[], ctx: ToolAccessContext): EnabledToolPolicyMatch {
  for (const policy of policies) {
    const conditions = policyConditions(policy);
    if (conditions && selectorMatches(policy.selectors, ctx)) {
      const parsed = toolPolicyConditionsSchema.safeParse(conditions);
      if (!parsed.success) {
        return {
          unsupportedConditions: {
            policy,
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          },
        };
      }
    }
  }
  return {
    matching: policies
      .map((policy) => ({ policy, conditionEvaluation: evaluatePolicyConditions(policyConditions(policy), ctx) }))
      .filter(({ policy, conditionEvaluation }) => selectorMatches(policy.selectors, ctx) && conditionEvaluation.matched),
  };
}

function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  return { next, pick };
}

const ids = (count: number) => Array.from({ length: count }, () => randomUUID());
const catalogIds = ids(30);
const connectionIds = ids(3);
const applicationIds = ids(2);
const agentIds = ids(3);
const projectIds = ids(2);
const toolNames = ["search", "deploy", "read_file", "write_file", "delete_repo", "list_issues"];
const upstreamNames = ["upstream_search", "deploy", "upstream_delete", null];
const riskLevels = ["read", "write", "destructive", "low", "high", null] as const;
const policyTypes = ["require_approval", "block", "trust_rule", "rate_limit", "allow", "redact"] as const;

function policyRow(index: number, values: Partial<PolicyRow>): PolicyRow {
  return {
    id: randomUUID(),
    companyId: "company",
    name: `Policy ${index}`,
    description: null,
    policyType: "require_approval",
    priority: 100,
    enabled: true,
    selectors: {},
    conditions: null,
    config: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    ...values,
  };
}

function randomSelector(random: ReturnType<typeof seeded>): Record<string, unknown> {
  const { next, pick } = random;
  const roll = next();
  if (roll < 0.35) return { catalogEntryId: pick(catalogIds) };
  if (roll < 0.45) return { catalogEntryId: pick(catalogIds), connectionId: pick(connectionIds) };
  if (roll < 0.5) { const id = pick(catalogIds); return { catalogEntryIds: [id, pick(catalogIds), id] }; }
  if (roll < 0.53) return { catalogEntryIds: `  ${pick(catalogIds)}  ` };
  if (roll < 0.56) return { catalogEntryId: "", toolName: pick(toolNames) };
  if (roll < 0.6) return { toolNames: [pick(toolNames), pick(upstreamNames.filter(Boolean))] };
  if (roll < 0.64) return { toolName: pick([...toolNames, "upstream_search"]), riskLevel: pick(riskLevels.filter(Boolean)) };
  if (roll < 0.67) return {};
  if (roll < 0.7) return { riskLevels: ["write", "destructive"] };
  if (roll < 0.73) return { actorType: "agent", agentIds: [pick(agentIds), pick(agentIds)] };
  if (roll < 0.75) return { catalogEntryId: 42, toolNames: [] };
  if (roll < 0.77) return { catalogEntryId: pick(catalogIds), catalogEntryIds: [pick(catalogIds)] };
  if (roll < 0.79) return { catalogEntryIds: ["", "   ", pick(catalogIds)] };
  if (roll < 0.81) return { toolName: "", projectId: pick(projectIds) };
  // Several other keys, with no catalog entry or tool name.
  const selector: Record<string, unknown> = {};
  if (next() < 0.5) selector.agentId = pick(agentIds);
  if (next() < 0.5) selector.applicationIds = [pick(applicationIds)];
  if (next() < 0.5) selector.connectionId = pick(connectionIds);
  if (next() < 0.5) selector.projectIds = projectIds;
  if (next() < 0.3) selector.providerType = pick(["mcp_remote_http", "paperclip_self"]);
  if (next() < 0.3) selector.applicationKeys = "github";
  if (next() < 0.3) selector.gatewayId = "gateway-1";
  if (next() < 0.3) selector.issueIds = ["issue-1", "issue-2"];
  if (next() < 0.3) selector.routineId = "routine-1";
  return selector;
}

function randomConditions(random: ReturnType<typeof seeded>): Record<string, unknown> | null {
  const { next, pick } = random;
  if (next() < 0.75) return null;
  return pick<Record<string, unknown>>([
    { risk: { isWrite: true } },
    { risk: { max: "read" } },
    { arguments: { fieldExists: ["query"] } },
    { arguments: { fieldEquals: { mode: "dry_run" } } },
    { context: { requireIssue: true } },
    { actor: { actorTypes: ["agent"] } },
    { trustBoundary: { remoteHttpOnly: true } },
    { timeWindow: { daysOfWeekUtc: [0, 1, 2, 3, 4, 5, 6] } },
    { timeWindow: { startAt: "2999-01-01T00:00:00Z" } },
    // Conditions the runtime cannot evaluate deny a selected call.
    { unknownGroup: { enabled: true } },
    { arguments: { fieldEquals: {} } },
  ]);
}

function randomPolicies(seed: number, count: number): PolicyRow[] {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => policyRow(index, {
    // "redact" is a legacy type the runtime no longer supports.
    policyType: random.pick(policyTypes) as PolicyRow["policyType"],
    priority: random.pick([10, 50, 100, 100, 100, 200]),
    selectors: randomSelector(random),
    conditions: randomConditions(random),
  })).sort((left, right) => left.priority - right.priority || left.createdAt.getTime() - right.createdAt.getTime());
}

function randomContext(random: ReturnType<typeof seeded>): ToolAccessContext {
  const { next, pick } = random;
  return {
    companyId: "company",
    actorType: pick(["agent", "agent", "user", "system"] as const),
    actorId: "actor",
    agentId: next() < 0.8 ? pick(agentIds) : null,
    heartbeatRunId: null,
    issueId: pick(["issue-1", "issue-3", null]),
    projectId: next() < 0.7 ? pick(projectIds) : null,
    routineId: pick(["routine-1", null]),
    gatewayId: pick(["gateway-1", null]),
    applicationId: pick([...applicationIds, null]),
    connectionId: next() < 0.9 ? pick(connectionIds) : null,
    // Some contexts name catalog entries that no policy selects, or none.
    catalogEntryId: next() < 0.85 ? pick(catalogIds) : pick([randomUUID(), null, ""]),
    catalogStatus: "active",
    catalogVersionHash: null,
    catalogSchemaHash: null,
    providerType: pick(["mcp_remote_http", "paperclip_self", null]),
    applicationKey: pick(["github", "linear", null]),
    upstreamToolName: pick(upstreamNames),
    toolName: pick([...toolNames, ""]),
    riskLevel: pick(riskLevels),
    argumentsHash: "hash",
    arguments: pick([{}, { query: "x" }, { mode: "dry_run" }]),
  };
}

function summary(match: EnabledToolPolicyMatch) {
  if ("unsupportedConditions" in match) {
    return { unsupported: match.unsupportedConditions.policy.id, issues: match.unsupportedConditions.issues };
  }
  return { matching: match.matching.map(({ policy, conditionEvaluation }) => ({ id: policy.id, conditionEvaluation })) };
}

describe("tool policy index", () => {
  it("compiles selectors that match exactly the contexts the raw selector matches", () => {
    const random = seeded(7);
    const selectors = [
      ...Array.from({ length: 400 }, () => randomSelector(random)),
      { catalogEntryIds: "   " },
      { toolName: 7, toolNames: "deploy" },
      { actorTypes: "agent" },
      { riskLevel: "" },
    ];
    let compared = 0;
    for (let index = 0; index < 300; index += 1) {
      const ctx = randomContext(random);
      for (const selector of selectors) {
        expect(compilePolicySelector(selector).matches(ctx)).toBe(selectorMatches(selector, ctx));
        compared += 1;
      }
    }
    expect(compared).toBe(300 * selectors.length);
  });

  it("selects the same policies, in the same order, as unindexed matching", () => {
    let unsupported = 0;
    let matched = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const policies = randomPolicies(seed, 400);
      const index = indexEnabledToolPolicies(policies);
      const random = seeded(seed * 101);
      for (let call = 0; call < 400; call += 1) {
        const ctx = randomContext(random);
        const expected = summary(unindexedMatch(policies, ctx));
        // A reused index must give the same answer as a fresh one.
        expect(summary(matchEnabledToolPolicies(index, ctx))).toEqual(expected);
        expect(summary(matchEnabledToolPolicies(indexEnabledToolPolicies(policies), ctx))).toEqual(expected);
        if ("unsupported" in expected) unsupported += 1;
        else if (expected.matching.length > 0) matched += 1;
      }
    }
    // The generated cases exercise both outcomes.
    expect(unsupported).toBeGreaterThan(50);
    expect(matched).toBeGreaterThan(250);
  });

  it("selects the same policies as unindexed matching for a staging-shaped set", () => {
    const random = seeded(11);
    const catalogEntries = Array.from({ length: 800 }, (_, index) => ({
      id: randomUUID(), connectionId: connectionIds[index % connectionIds.length]!, toolName: `tool_${index}`,
    }));
    const policies = stagingShapedToolPolicies({
      catalogEntries, agentId: agentIds[0]!, projectId: projectIds[0]!, applicationId: applicationIds[0]!, connectionId: connectionIds[0]!,
    }).map((values, position) => policyRow(position, {
      ...values, priority: values.priority ?? 100, selectors: values.selectors ?? {}, conditions: values.conditions ?? null, config: values.config ?? null,
    })).sort((left, right) => left.priority - right.priority || left.createdAt.getTime() - right.createdAt.getTime());
    const index = indexEnabledToolPolicies(policies);
    let matched = 0;
    for (const [position, entry] of catalogEntries.entries()) {
      const ctx: ToolAccessContext = {
        ...randomContext(random),
        agentId: agentIds[0]!, projectId: projectIds[0]!, applicationId: applicationIds[0]!,
        connectionId: entry.connectionId, catalogEntryId: entry.id, toolName: entry.toolName,
        upstreamToolName: position % 2 === 0 ? entry.toolName : null,
      };
      const expected = summary(unindexedMatch(policies, ctx));
      expect(summary(matchEnabledToolPolicies(index, ctx))).toEqual(expected);
      if ((expected.matching?.length ?? 0) > 0) matched += 1;
    }
    expect(matched).toBeGreaterThan(300);
  });

  it("applies an earlier policy from another index bucket before a catalog-entry policy", () => {
    const catalogEntryId = randomUUID();
    const otherCatalogEntryId = randomUUID();
    const policies = [
      // No catalog entry: indexed by tool name, matched through the upstream name.
      policyRow(0, { priority: 5, policyType: "require_approval", selectors: { toolNames: ["upstream_deploy"] } }),
      // Neither key: a candidate for every call.
      policyRow(1, { priority: 6, policyType: "trust_rule", selectors: { riskLevel: "write" } }),
      // An empty catalog entry selector does not constrain the call.
      policyRow(2, { priority: 7, policyType: "allow", selectors: { catalogEntryId: "", toolName: "deploy" } }),
      policyRow(3, { priority: 10, policyType: "block", selectors: { catalogEntryId } }),
      policyRow(4, { priority: 20, policyType: "require_approval", selectors: { catalogEntryIds: [otherCatalogEntryId, catalogEntryId] } }),
      policyRow(5, { priority: 30, policyType: "block", selectors: { catalogEntryId: otherCatalogEntryId } }),
    ];
    const ctx: ToolAccessContext = {
      ...randomContext(seeded(3)),
      catalogEntryId, toolName: "deploy", upstreamToolName: "upstream_deploy", riskLevel: "write",
    };
    const match = matchEnabledToolPolicies(indexEnabledToolPolicies(policies), ctx);
    expect(summary(match)).toEqual(summary(unindexedMatch(policies, ctx)));
    expect("matching" in match && match.matching.map(({ policy }) => policy.name))
      .toEqual(["Policy 0", "Policy 1", "Policy 2", "Policy 3", "Policy 4"]);

    // A selected policy with unsupported conditions denies the call even when
    // a catalog-entry policy sits earlier in a different bucket.
    const unsupported = [
      policyRow(0, { priority: 1, selectors: { catalogEntryId } }),
      policyRow(1, { priority: 2, selectors: { toolName: "deploy" }, conditions: { unknownGroup: true } }),
    ];
    expect(matchEnabledToolPolicies(indexEnabledToolPolicies(unsupported), ctx)).toMatchObject({
      unsupportedConditions: { policy: { name: "Policy 1" } },
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

/** A db handle whose tool_policies rows count every read of their selectors. */
function countingPolicySelectorReads(db: Db) {
  const counter = { reads: 0 };
  const counted = new Proxy(db, {
    get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<DbClient["select"]>) => {
        const builder = target.select(...fields);
        const from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args);
          if (args[0] !== toolPolicies) return selection;
          const execute = selection.execute.bind(selection);
          selection.execute = (async (...executeArgs: Parameters<typeof execute>) => {
            const rows = await execute(...executeArgs) as PolicyRow[];
            return rows.map((row) => ({
              ...row,
              selectors: new Proxy(row.selectors, {
                get(selector, property, receiver) {
                  counter.reads += 1;
                  return Reflect.get(selector, property, receiver);
                },
                ownKeys(selector) {
                  counter.reads += 1;
                  return Reflect.ownKeys(selector);
                },
              }),
            }));
          }) as typeof execute;
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    },
  });
  return { db: counted, counter };
}

describeEmbeddedPostgres("tool policy index decisions", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-policy-index-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function decisionInput(
    fixture: Awaited<ReturnType<typeof createListingFixture>>,
    entry: Awaited<ReturnType<typeof createListingFixture>>["entries"][number],
  ): ToolAccessDecisionInput {
    return {
      companyId: fixture.company.id,
      actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
      runContext: { heartbeatRunId: fixture.run.id, issueId: fixture.issue.id, projectId: fixture.project.id, gatewayId: fixture.namedGateway.id },
      request: {
        toolName: entry.toolName!, applicationId: fixture.application.id, connectionId: fixture.connection.id,
        catalogEntryId: entry.id, upstreamToolName: entry.toolName!, riskLevel: entry.riskLevel, arguments: { query: "status" },
      },
      consumeRateLimit: false,
    };
  }

  it("reads policy selectors once per decision batch, however many tools it decides", async () => {
    const fixture = await createListingFixture(db, 40);
    await db.insert(toolPolicies).values(stagingShapedToolPolicies({
      catalogEntries: Array.from({ length: 800 }, (_, index) => fixture.entries[index] ?? { id: randomUUID(), connectionId: null, toolName: null }),
      agentId: fixture.agent.id,
      projectId: fixture.project.id,
      applicationId: fixture.application.id,
      connectionId: fixture.connection.id,
    }).map((values) => ({ ...values, companyId: fixture.company.id })));
    const { db: counted, counter } = countingPolicySelectorReads(db);
    const policy = toolAccessPolicyService(counted);
    const cache = createToolAccessDecisionCache();

    const first = await policy.decide(decisionInput(fixture, fixture.entries[0]!), { cache });
    const readsForOneTool = counter.reads;
    const rest = [];
    for (const entry of fixture.entries.slice(1)) rest.push(await policy.decide(decisionInput(fixture, entry), { cache }));

    expect(readsForOneTool).toBeGreaterThan(0);
    expect(counter.reads).toBe(readsForOneTool);
    const uncached = toolAccessPolicyService(db);
    const expected = [];
    for (const entry of fixture.entries) expected.push(await uncached.decide(decisionInput(fixture, entry)));
    expect([first, ...rest]).toEqual(expected);
    expect(new Set(expected.map((decision) => decision.reasonCode))).toEqual(new Set([
      "allow_profile", "deny_default", "deny_policy_block", "requires_approval_policy",
    ]));
  }, 30_000);

  it("lets an earlier tool-name policy decide before a catalog-entry block", async () => {
    const fixture = await createListingFixture(db, 6);
    const [blocked, written] = [fixture.entries[2]!, fixture.entries[3]!];
    // The fixture blocks entries[2] at priority 10 and asks first for writes at 20.
    const [byToolName] = await db.insert(toolPolicies).values({
      companyId: fixture.company.id,
      name: `Ask first by tool name ${randomUUID()}`,
      description: "Ask before this action.",
      policyType: "require_approval",
      priority: 5,
      selectors: { toolNames: [blocked.toolName!] },
    }).returning();
    const policy = toolAccessPolicyService(db);
    for (const cache of [undefined, createToolAccessDecisionCache()]) {
      const blockedDecision = await policy.decide(decisionInput(fixture, blocked), { cache });
      expect(blockedDecision).toMatchObject({
        decision: "require_approval",
        reasonCode: "requires_approval_policy",
        explanation: "Ask before this action.",
        matchedPolicyIds: [byToolName!.id],
        policyExplanation: { policyId: byToolName!.id, selectorMatched: true, conditionsMatched: [] },
      });
      const writeDecision = await policy.decide(decisionInput(fixture, written), { cache });
      expect(writeDecision).toMatchObject({ decision: "require_approval", reasonCode: "requires_approval_policy" });
      expect(writeDecision.matchedPolicyIds).not.toContain(byToolName!.id);
    }
  }, 30_000);
});
