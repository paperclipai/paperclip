import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// cost.ts
// ---------------------------------------------------------------------------
import {
  createCostEventSchema,
  updateBudgetSchema,
} from "./cost.js";

// ---------------------------------------------------------------------------
// finance.ts
// ---------------------------------------------------------------------------
import { createFinanceEventSchema } from "./finance.js";

// ---------------------------------------------------------------------------
// approval.ts
// ---------------------------------------------------------------------------
import {
  createApprovalSchema,
  resolveApprovalSchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
  addApprovalCommentSchema,
} from "./approval.js";

// ---------------------------------------------------------------------------
// budget.ts
// ---------------------------------------------------------------------------
import {
  upsertBudgetPolicySchema,
  resolveBudgetIncidentSchema,
} from "./budget.js";

// ---------------------------------------------------------------------------
// secret.ts
// ---------------------------------------------------------------------------
import {
  envBindingPlainSchema,
  envBindingSecretRefSchema,
  envBindingSchema,
  envConfigSchema,
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "./secret.js";

// ---------------------------------------------------------------------------
// access.ts
// ---------------------------------------------------------------------------
import {
  createCompanyInviteSchema,
  acceptInviteSchema,
  listJoinRequestsQuerySchema,
  claimJoinRequestApiKeySchema,
  createCliAuthChallengeSchema,
  resolveCliAuthChallengeSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
} from "./access.js";

// ============================================================================
// cost.ts
// ============================================================================

describe("createCostEventSchema", () => {
  const validBase = {
    agentId: "00000000-0000-0000-0000-000000000001",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    inputTokens: 100,
    outputTokens: 50,
    costCents: 12,
    occurredAt: new Date().toISOString(),
  };

  it("parses a valid cost event", () => {
    const result = createCostEventSchema.parse(validBase);
    expect(result.provider).toBe("anthropic");
    expect(result.costCents).toBe(12);
  });

  it("defaults billingType to 'unknown'", () => {
    const result = createCostEventSchema.parse(validBase);
    expect(result.billingType).toBe("unknown");
  });

  it("defaults inputTokens to 0 when omitted", () => {
    const { inputTokens: _, ...rest } = validBase;
    const result = createCostEventSchema.parse(rest);
    expect(result.inputTokens).toBe(0);
  });

  it("sets biller to provider when biller is omitted", () => {
    const result = createCostEventSchema.parse(validBase);
    expect(result.biller).toBe("anthropic");
  });

  it("uses explicit biller when provided", () => {
    const result = createCostEventSchema.parse({ ...validBase, biller: "acme" });
    expect(result.biller).toBe("acme");
  });

  it("rejects negative costCents", () => {
    expect(() => createCostEventSchema.parse({ ...validBase, costCents: -1 })).toThrow();
  });

  it("rejects fractional inputTokens", () => {
    expect(() => createCostEventSchema.parse({ ...validBase, inputTokens: 1.5 })).toThrow();
  });

  it("rejects invalid datetime for occurredAt", () => {
    expect(() => createCostEventSchema.parse({ ...validBase, occurredAt: "not-a-date" })).toThrow();
  });

  it("rejects invalid UUID for agentId", () => {
    expect(() => createCostEventSchema.parse({ ...validBase, agentId: "not-a-uuid" })).toThrow();
  });
});

describe("updateBudgetSchema", () => {
  it("parses a valid budget update", () => {
    const result = updateBudgetSchema.parse({ budgetMonthlyCents: 5000 });
    expect(result.budgetMonthlyCents).toBe(5000);
  });

  it("accepts zero", () => {
    const result = updateBudgetSchema.parse({ budgetMonthlyCents: 0 });
    expect(result.budgetMonthlyCents).toBe(0);
  });

  it("rejects negative amounts", () => {
    expect(() => updateBudgetSchema.parse({ budgetMonthlyCents: -1 })).toThrow();
  });

  it("rejects fractional amounts", () => {
    expect(() => updateBudgetSchema.parse({ budgetMonthlyCents: 1.5 })).toThrow();
  });
});

// ============================================================================
// finance.ts
// ============================================================================

describe("createFinanceEventSchema", () => {
  const validBase = {
    biller: "stripe",
    eventKind: "inference_charge",
    amountCents: 100,
    occurredAt: new Date().toISOString(),
  };

  it("parses a valid finance event", () => {
    const result = createFinanceEventSchema.parse(validBase);
    expect(result.biller).toBe("stripe");
    expect(result.amountCents).toBe(100);
  });

  it("defaults direction to 'debit'", () => {
    const result = createFinanceEventSchema.parse(validBase);
    expect(result.direction).toBe("debit");
  });

  it("defaults currency to 'USD'", () => {
    const result = createFinanceEventSchema.parse(validBase);
    expect(result.currency).toBe("USD");
  });

  it("upcases the currency", () => {
    const result = createFinanceEventSchema.parse({ ...validBase, currency: "eur" });
    expect(result.currency).toBe("EUR");
  });

  it("defaults estimated to false", () => {
    const result = createFinanceEventSchema.parse(validBase);
    expect(result.estimated).toBe(false);
  });

  it("rejects invalid eventKind", () => {
    expect(() => createFinanceEventSchema.parse({ ...validBase, eventKind: "nope" })).toThrow();
  });

  it("rejects currency with wrong length", () => {
    expect(() => createFinanceEventSchema.parse({ ...validBase, currency: "US" })).toThrow();
  });

  it("rejects negative amountCents", () => {
    expect(() => createFinanceEventSchema.parse({ ...validBase, amountCents: -1 })).toThrow();
  });
});

// ============================================================================
// approval.ts
// ============================================================================

describe("createApprovalSchema", () => {
  it("parses a valid approval", () => {
    const result = createApprovalSchema.parse({
      type: "hire_agent",
      payload: { reason: "need more capacity" },
    });
    expect(result.type).toBe("hire_agent");
    expect(result.payload).toEqual({ reason: "need more capacity" });
  });

  it("accepts optional issueIds array", () => {
    const id = "00000000-0000-0000-0000-000000000002";
    const result = createApprovalSchema.parse({
      type: "hire_agent",
      payload: {},
      issueIds: [id],
    });
    expect(result.issueIds).toEqual([id]);
  });

  it("rejects invalid approval type", () => {
    expect(() => createApprovalSchema.parse({ type: "invalid", payload: {} })).toThrow();
  });

  it("rejects non-record payload", () => {
    expect(() => createApprovalSchema.parse({ type: "hire_agent", payload: "string" })).toThrow();
  });
});

describe("resolveApprovalSchema", () => {
  it("parses with defaults", () => {
    const result = resolveApprovalSchema.parse({});
    expect(result.decidedByUserId).toBe("board");
  });

  it("accepts a decision note", () => {
    const result = resolveApprovalSchema.parse({ decisionNote: "approved" });
    expect(result.decisionNote).toBe("approved");
  });
});

describe("requestApprovalRevisionSchema", () => {
  it("parses with defaults", () => {
    const result = requestApprovalRevisionSchema.parse({});
    expect(result.decidedByUserId).toBe("board");
  });
});

describe("resubmitApprovalSchema", () => {
  it("parses empty object", () => {
    const result = resubmitApprovalSchema.parse({});
    expect(result.payload).toBeUndefined();
  });

  it("accepts an updated payload", () => {
    const result = resubmitApprovalSchema.parse({ payload: { updated: true } });
    expect(result.payload).toEqual({ updated: true });
  });
});

describe("addApprovalCommentSchema", () => {
  it("parses a non-empty body", () => {
    const result = addApprovalCommentSchema.parse({ body: "looks good" });
    expect(result.body).toBe("looks good");
  });

  it("rejects an empty body", () => {
    expect(() => addApprovalCommentSchema.parse({ body: "" })).toThrow();
  });
});

// ============================================================================
// budget.ts
// ============================================================================

describe("upsertBudgetPolicySchema", () => {
  const validBase = {
    scopeType: "company",
    scopeId: "00000000-0000-0000-0000-000000000003",
    amount: 100000,
  };

  it("parses a valid budget policy", () => {
    const result = upsertBudgetPolicySchema.parse(validBase);
    expect(result.scopeType).toBe("company");
    expect(result.amount).toBe(100000);
  });

  it("defaults metric to 'billed_cents'", () => {
    const result = upsertBudgetPolicySchema.parse(validBase);
    expect(result.metric).toBe("billed_cents");
  });

  it("defaults windowKind to 'calendar_month_utc'", () => {
    const result = upsertBudgetPolicySchema.parse(validBase);
    expect(result.windowKind).toBe("calendar_month_utc");
  });

  it("defaults warnPercent to 80", () => {
    const result = upsertBudgetPolicySchema.parse(validBase);
    expect(result.warnPercent).toBe(80);
  });

  it("defaults hardStopEnabled to true", () => {
    const result = upsertBudgetPolicySchema.parse(validBase);
    expect(result.hardStopEnabled).toBe(true);
  });

  it("rejects warnPercent of 0", () => {
    expect(() => upsertBudgetPolicySchema.parse({ ...validBase, warnPercent: 0 })).toThrow();
  });

  it("rejects warnPercent of 100", () => {
    expect(() => upsertBudgetPolicySchema.parse({ ...validBase, warnPercent: 100 })).toThrow();
  });

  it("rejects invalid scopeType", () => {
    expect(() => upsertBudgetPolicySchema.parse({ ...validBase, scopeType: "team" })).toThrow();
  });
});

describe("resolveBudgetIncidentSchema", () => {
  it("parses 'keep_paused' without amount", () => {
    const result = resolveBudgetIncidentSchema.parse({ action: "keep_paused" });
    expect(result.action).toBe("keep_paused");
  });

  it("parses 'raise_budget_and_resume' with amount", () => {
    const result = resolveBudgetIncidentSchema.parse({
      action: "raise_budget_and_resume",
      amount: 50000,
    });
    expect(result.amount).toBe(50000);
  });

  it("rejects 'raise_budget_and_resume' without amount", () => {
    expect(() =>
      resolveBudgetIncidentSchema.parse({ action: "raise_budget_and_resume" })
    ).toThrow();
  });

  it("accepts optional decisionNote", () => {
    const result = resolveBudgetIncidentSchema.parse({
      action: "keep_paused",
      decisionNote: "waiting for review",
    });
    expect(result.decisionNote).toBe("waiting for review");
  });
});

// ============================================================================
// secret.ts
// ============================================================================

describe("envBindingPlainSchema", () => {
  it("parses a plain binding", () => {
    const result = envBindingPlainSchema.parse({ type: "plain", value: "abc" });
    expect(result.type).toBe("plain");
    expect(result.value).toBe("abc");
  });

  it("rejects wrong type literal", () => {
    expect(() => envBindingPlainSchema.parse({ type: "secret_ref", value: "x" })).toThrow();
  });
});

describe("envBindingSecretRefSchema", () => {
  it("parses a secret_ref binding", () => {
    const result = envBindingSecretRefSchema.parse({
      type: "secret_ref",
      secretId: "00000000-0000-0000-0000-000000000004",
    });
    expect(result.type).toBe("secret_ref");
    expect(result.secretId).toBe("00000000-0000-0000-0000-000000000004");
  });

  it("accepts 'latest' version", () => {
    const result = envBindingSecretRefSchema.parse({
      type: "secret_ref",
      secretId: "00000000-0000-0000-0000-000000000004",
      version: "latest",
    });
    expect(result.version).toBe("latest");
  });

  it("accepts integer version", () => {
    const result = envBindingSecretRefSchema.parse({
      type: "secret_ref",
      secretId: "00000000-0000-0000-0000-000000000004",
      version: 3,
    });
    expect(result.version).toBe(3);
  });

  it("rejects non-UUID secretId", () => {
    expect(() =>
      envBindingSecretRefSchema.parse({ type: "secret_ref", secretId: "not-uuid" })
    ).toThrow();
  });
});

describe("envBindingSchema", () => {
  it("accepts a bare string (legacy inline value)", () => {
    const result = envBindingSchema.parse("direct-value");
    expect(result).toBe("direct-value");
  });

  it("accepts a plain object", () => {
    const result = envBindingSchema.parse({ type: "plain", value: "v" });
    expect(result).toMatchObject({ type: "plain" });
  });

  it("accepts a secret_ref object", () => {
    const result = envBindingSchema.parse({
      type: "secret_ref",
      secretId: "00000000-0000-0000-0000-000000000005",
    });
    expect(result).toMatchObject({ type: "secret_ref" });
  });

  it("rejects a number", () => {
    expect(() => envBindingSchema.parse(42)).toThrow();
  });
});

describe("envConfigSchema", () => {
  it("parses a record of env bindings", () => {
    const result = envConfigSchema.parse({
      FOO: "bar",
      TOKEN: { type: "plain", value: "xyz" },
    });
    expect(result.FOO).toBe("bar");
    expect(result.TOKEN).toMatchObject({ type: "plain", value: "xyz" });
  });

  it("rejects non-object at root", () => {
    expect(() => envConfigSchema.parse(["array"])).toThrow();
  });
});

describe("createSecretSchema", () => {
  it("parses a valid secret", () => {
    const result = createSecretSchema.parse({ name: "my-secret", value: "s3cr3t" });
    expect(result.name).toBe("my-secret");
    expect(result.value).toBe("s3cr3t");
  });

  it("rejects empty name", () => {
    expect(() => createSecretSchema.parse({ name: "", value: "v" })).toThrow();
  });

  it("rejects empty value", () => {
    expect(() => createSecretSchema.parse({ name: "n", value: "" })).toThrow();
  });

  it("accepts valid provider", () => {
    const result = createSecretSchema.parse({ name: "n", value: "v", provider: "local_encrypted" });
    expect(result.provider).toBe("local_encrypted");
  });
});

describe("rotateSecretSchema", () => {
  it("parses with a new value", () => {
    const result = rotateSecretSchema.parse({ value: "new-val" });
    expect(result.value).toBe("new-val");
  });

  it("rejects empty value", () => {
    expect(() => rotateSecretSchema.parse({ value: "" })).toThrow();
  });
});

describe("updateSecretSchema", () => {
  it("parses an empty object (all optional)", () => {
    const result = updateSecretSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts partial updates", () => {
    const result = updateSecretSchema.parse({ name: "new-name" });
    expect(result.name).toBe("new-name");
  });
});

// ============================================================================
// access.ts
// ============================================================================

describe("createCompanyInviteSchema", () => {
  it("parses with defaults", () => {
    const result = createCompanyInviteSchema.parse({});
    expect(result.allowedJoinTypes).toBe("both");
  });

  it("accepts allowedJoinTypes 'agent'", () => {
    const result = createCompanyInviteSchema.parse({ allowedJoinTypes: "agent" });
    expect(result.allowedJoinTypes).toBe("agent");
  });

  it("rejects invalid allowedJoinTypes", () => {
    expect(() => createCompanyInviteSchema.parse({ allowedJoinTypes: "robot" })).toThrow();
  });

  it("rejects agentMessage over 4000 chars", () => {
    expect(() =>
      createCompanyInviteSchema.parse({ agentMessage: "x".repeat(4001) })
    ).toThrow();
  });
});

describe("acceptInviteSchema", () => {
  it("parses with requestType 'agent'", () => {
    const result = acceptInviteSchema.parse({ requestType: "agent" });
    expect(result.requestType).toBe("agent");
  });

  it("parses with requestType 'human'", () => {
    const result = acceptInviteSchema.parse({ requestType: "human" });
    expect(result.requestType).toBe("human");
  });

  it("rejects invalid requestType", () => {
    expect(() => acceptInviteSchema.parse({ requestType: "bot" })).toThrow();
  });

  it("accepts optional agentName", () => {
    const result = acceptInviteSchema.parse({ requestType: "agent", agentName: "MyAgent" });
    expect(result.agentName).toBe("MyAgent");
  });

  it("rejects agentName over 120 chars", () => {
    expect(() =>
      acceptInviteSchema.parse({ requestType: "agent", agentName: "a".repeat(121) })
    ).toThrow();
  });
});

describe("listJoinRequestsQuerySchema", () => {
  it("parses empty query (all optional)", () => {
    const result = listJoinRequestsQuerySchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts a valid status", () => {
    const result = listJoinRequestsQuerySchema.parse({ status: "pending_approval" });
    expect(result.status).toBe("pending_approval");
  });

  it("accepts a valid requestType", () => {
    const result = listJoinRequestsQuerySchema.parse({ requestType: "agent" });
    expect(result.requestType).toBe("agent");
  });
});

describe("claimJoinRequestApiKeySchema", () => {
  it("parses a valid claimSecret", () => {
    const secret = "a".repeat(16);
    const result = claimJoinRequestApiKeySchema.parse({ claimSecret: secret });
    expect(result.claimSecret).toBe(secret);
  });

  it("rejects claimSecret shorter than 16 chars", () => {
    expect(() =>
      claimJoinRequestApiKeySchema.parse({ claimSecret: "short" })
    ).toThrow();
  });

  it("rejects claimSecret longer than 256 chars", () => {
    expect(() =>
      claimJoinRequestApiKeySchema.parse({ claimSecret: "a".repeat(257) })
    ).toThrow();
  });
});

describe("createCliAuthChallengeSchema", () => {
  it("parses a valid challenge", () => {
    const result = createCliAuthChallengeSchema.parse({
      command: "paperclip auth login",
    });
    expect(result.command).toBe("paperclip auth login");
    expect(result.requestedAccess).toBe("board");
  });

  it("defaults requestedAccess to 'board'", () => {
    const result = createCliAuthChallengeSchema.parse({ command: "cmd" });
    expect(result.requestedAccess).toBe("board");
  });

  it("accepts 'instance_admin_required'", () => {
    const result = createCliAuthChallengeSchema.parse({
      command: "cmd",
      requestedAccess: "instance_admin_required",
    });
    expect(result.requestedAccess).toBe("instance_admin_required");
  });

  it("rejects empty command", () => {
    expect(() => createCliAuthChallengeSchema.parse({ command: "" })).toThrow();
  });

  it("rejects command over 240 chars", () => {
    expect(() =>
      createCliAuthChallengeSchema.parse({ command: "x".repeat(241) })
    ).toThrow();
  });
});

describe("resolveCliAuthChallengeSchema", () => {
  it("parses a valid token", () => {
    const token = "t".repeat(32);
    const result = resolveCliAuthChallengeSchema.parse({ token });
    expect(result.token).toBe(token);
  });

  it("rejects token under 16 chars", () => {
    expect(() => resolveCliAuthChallengeSchema.parse({ token: "short" })).toThrow();
  });
});

describe("updateMemberPermissionsSchema", () => {
  it("parses an empty grants array", () => {
    const result = updateMemberPermissionsSchema.parse({ grants: [] });
    expect(result.grants).toHaveLength(0);
  });

  it("parses grants with a valid permissionKey", () => {
    const result = updateMemberPermissionsSchema.parse({
      grants: [{ permissionKey: "agents:create" }],
    });
    expect(result.grants[0]?.permissionKey).toBe("agents:create");
  });

  it("rejects an invalid permissionKey", () => {
    expect(() =>
      updateMemberPermissionsSchema.parse({ grants: [{ permissionKey: "invalid:key" }] })
    ).toThrow();
  });
});

describe("updateUserCompanyAccessSchema", () => {
  it("defaults companyIds to empty array", () => {
    const result = updateUserCompanyAccessSchema.parse({});
    expect(result.companyIds).toEqual([]);
  });

  it("accepts UUID companyIds", () => {
    const id = "00000000-0000-0000-0000-000000000006";
    const result = updateUserCompanyAccessSchema.parse({ companyIds: [id] });
    expect(result.companyIds).toEqual([id]);
  });

  it("rejects non-UUID companyIds", () => {
    expect(() =>
      updateUserCompanyAccessSchema.parse({ companyIds: ["not-uuid"] })
    ).toThrow();
  });
});
