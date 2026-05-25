import { randomUUID } from "node:crypto";
import {
  adapterReadinessProbes,
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import { Router } from "express";

import { notFound } from "../errors.js";
import { assertBoard } from "./authz.js";

export function weeklyReviewFixtureRoutes(db: Db, opts: { enabled?: boolean } = {}) {
  const router = Router();
  const enabled = opts.enabled ?? process.env.PAPERCLIP_ENABLE_NORTHSTAR_FIXTURE_SEED === "true";

  router.post("/weekly-review-fixtures/northstar", async (req, res) => {
    if (!enabled) {
      throw notFound();
    }
    assertBoard(req);

    const seeded = await seedNorthstarWeeklyReviewFixture(db);
    res.status(201).json(seeded);
  });

  return router;
}

async function seedNorthstarWeeklyReviewFixture(db: Db) {
  const now = new Date();
  const twoDaysAgo = offsetDate(now, -2);
  const nineDaysAgo = offsetDate(now, -9);
  const expiresAt = offsetDate(now, 14);
  const suffix = randomUUID().slice(0, 8);
  const companyId = randomUUID();
  const issuePrefix = `NS${suffix.slice(0, 4).toUpperCase()}`;
  const agentIds = {
    ceo: randomUUID(),
    product: randomUUID(),
    engineering: randomUUID(),
    research: randomUUID(),
    support: randomUUID(),
    finance: randomUUID(),
  };
  const issueIds = {
    supportHandoff: randomUUID(),
    researchClaim: randomUUID(),
    staleRunbook: randomUUID(),
    inboxDigest: randomUUID(),
  };
  const failedRunId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(companies).values({
      id: companyId,
      name: `Northstar Labs ${suffix}`,
      description: "Seed company for the Weekly Review CEO smoke fixture.",
      issuePrefix,
      issueCounter: 4,
      requireBoardApprovalForNewAgents: false,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(agents).values([
      agentRow(agentIds.ceo, companyId, "CEO", "Chief Executive Officer", "claude_local", now, {
        selectedModel: "claude-sonnet-4.5",
      }),
      agentRow(agentIds.product, companyId, "Product Lead", "Product Lead", "claude_local", now, {
        selectedModel: "claude-sonnet-4.5",
      }),
      agentRow(agentIds.engineering, companyId, "Engineering Lead", "Engineering Lead", "codex_local", now, {
        selectedModel: "gpt-5.3-codex",
      }),
      agentRow(agentIds.research, companyId, "Research & Insights Lead", "Research & Insights Lead", "agy_local", now, {
        selectedModel: "gemini-3.5-flash",
        requiredModel: "gemini-3.5-flash",
      }),
      agentRow(agentIds.support, companyId, "Support/Ops Lead", "Support/Ops Lead", "claude_local", now, {
        selectedModel: "claude-sonnet-4.5",
      }),
      agentRow(agentIds.finance, companyId, "Finance/Ops Analyst", "Finance/Ops Analyst", "claude_local", now, {
        selectedModel: "claude-sonnet-4.5",
      }),
    ]);

    await tx.insert(issues).values([
      issueRow({
        id: issueIds.supportHandoff,
        companyId,
        title: "Support handoff owner missing blocks broad rollout",
        description:
          "Support handoff for the broad rollout is blocked because no owner is assigned. This is the CEO decision blocker for the week.",
        status: "blocked",
        priority: "urgent",
        issueNumber: 1,
        identifier: "NSR-1",
        createdAt: twoDaysAgo,
        updatedAt: twoDaysAgo,
      }),
      issueRow({
        id: issueIds.researchClaim,
        companyId,
        title: "Research brief has unsupported customer-segment claim",
        description:
          "Research must validate a customer-segment claim before the limited pilot narrative is reused.",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentIds.research,
        issueNumber: 2,
        identifier: "NSR-2",
        createdAt: twoDaysAgo,
        updatedAt: twoDaysAgo,
      }),
      issueRow({
        id: issueIds.staleRunbook,
        companyId,
        title: "Operations runbook is stale before limited pilot",
        description:
          "Operations runbook is stale and needs a refresh before launch readiness can be trusted.",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentIds.support,
        issueNumber: 3,
        identifier: "NSR-3",
        createdAt: nineDaysAgo,
        updatedAt: nineDaysAgo,
      }),
      issueRow({
        id: issueIds.inboxDigest,
        companyId,
        title: "Weekly inbox digest ready for limited pilot",
        description:
          "Weekly inbox digest is ready for limited pilot and gives the CEO one concrete win to acknowledge.",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentIds.product,
        issueNumber: 4,
        identifier: "NSR-4",
        completedAt: twoDaysAgo,
        createdAt: twoDaysAgo,
        updatedAt: twoDaysAgo,
      }),
    ]);

    await tx.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: issueIds.researchClaim,
      authorType: "agent",
      authorAgentId: agentIds.research,
      body:
        "The customer-segment claim is unsupported until research validation is complete; do not ship it in the limited pilot summary.",
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
    });

    await tx.insert(approvals).values({
      id: randomUUID(),
      companyId,
      type: "approve_limited_pilot_rollout",
      requestedByAgentId: agentIds.product,
      status: "pending",
      payload: {
        title: "Approve limited pilot rollout",
        summary: "Limited pilot rollout requires CEO approval before support handoff is complete.",
      },
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
    });

    await tx.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: agentIds.research,
      invocationSource: "scheduled",
      triggerDetail: "research validation",
      status: "failed",
      startedAt: twoDaysAgo,
      finishedAt: twoDaysAgo,
      error: "research validation failed on required segment evidence",
      resultJson: {
        workflow: "research validation",
        outcome: "failed",
      },
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
    });

    await tx.insert(costEvents).values({
      id: randomUUID(),
      companyId,
      agentId: agentIds.finance,
      issueId: issueIds.researchClaim,
      heartbeatRunId: failedRunId,
      billingCode: "citation-validation-retry-prototype",
      provider: "openai",
      biller: "paperclip",
      billingType: "tokens",
      model: "prototype-citation-retry",
      inputTokens: 3200,
      outputTokens: 900,
      costCents: 1847,
      occurredAt: twoDaysAgo,
      createdAt: twoDaysAgo,
    });

    await tx.insert(adapterReadinessProbes).values([
      readinessRow(agentIds.ceo, companyId, "claude_local", "claude-sonnet-4.5", now, expiresAt),
      readinessRow(agentIds.product, companyId, "claude_local", "claude-sonnet-4.5", now, expiresAt),
      readinessRow(agentIds.engineering, companyId, "codex_local", "gpt-5.3-codex", now, expiresAt),
      readinessRow(agentIds.research, companyId, "agy_local", "gemini-3.5-flash", now, expiresAt),
      readinessRow(agentIds.support, companyId, "claude_local", "claude-sonnet-4.5", now, expiresAt),
      readinessRow(agentIds.finance, companyId, "claude_local", "claude-sonnet-4.5", now, expiresAt),
    ]);
  });

  return {
    company: {
      id: companyId,
      name: `Northstar Labs ${suffix}`,
      issuePrefix,
    },
    agents: agentIds,
    issues: issueIds,
  };
}

function offsetDate(base: Date, days: number) {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function agentRow(
  id: string,
  companyId: string,
  name: string,
  role: string,
  adapterType: string,
  now: Date,
  adapterConfig: Record<string, unknown>,
) {
  return {
    id,
    companyId,
    name,
    role,
    title: role,
    status: "idle",
    adapterType,
    adapterConfig,
    capabilities: "Weekly review fixture agent",
    budgetMonthlyCents: 5000,
    createdAt: now,
    updatedAt: now,
  };
}

function issueRow(input: {
  id: string;
  companyId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  issueNumber: number;
  identifier: string;
  assigneeAgentId?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: input.id,
    companyId: input.companyId,
    title: input.title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    assigneeAgentId: input.assigneeAgentId,
    issueNumber: input.issueNumber,
    identifier: input.identifier,
    originKind: "weekly_review_fixture",
    originId: input.identifier,
    originFingerprint: input.identifier,
    completedAt: input.completedAt,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function readinessRow(
  agentId: string,
  companyId: string,
  adapterType: string,
  model: string,
  checkedAt: Date,
  expiresAt: Date,
) {
  return {
    id: randomUUID(),
    companyId,
    agentId,
    adapterType,
    status: "ready",
    basicReady: true,
    operationalReady: true,
    fixtureReady: true,
    reasonCodesJson: [],
    cliVersion: "fixture",
    authMode: "local",
    model,
    resolvedModel: model,
    modelSource: "adapter_config",
    modelProfile: "primary",
    modelAvailable: true,
    modelRunnable: true,
    modelPolicyStatus: "approved_primary",
    roleFit: "strong",
    roleFitReason: "Fixture model policy matches the agent role.",
    modelReasonCodesJson: [],
    modelCapabilitiesJson: {
      text: true,
      toolUse: true,
    },
    workspaceStatus: "ready",
    helloRunStatus: "passed",
    strictMode: true,
    checkedAt,
    expiresAt,
    createdAt: checkedAt,
  };
}
