import type {
  AdapterReadinessReasonCode,
  AdapterReadinessStatus,
  LocalAdapterAssuranceType,
} from "@paperclipai/shared";
import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { adapterReadinessProbes, agents } from "@paperclipai/db";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";

import { findActiveServerAdapter } from "../../adapters/index.js";
import { badRequest, notFound } from "../../errors.js";
import { evaluateModelAssurance, type EvaluateModelAssuranceInput } from "../model-assurance/index.js";
import { computeProbeExpiresAt } from "../weekly-review/retention.js";

export interface EvaluateAdapterReadinessInput {
  adapterType: LocalAdapterAssuranceType;
  cliFound: boolean;
  authOk: boolean;
  modelOk: boolean;
  workspaceOk: boolean;
  helloRunOk: boolean | null;
  operationalWarnings: AdapterReadinessReasonCode[];
  fixtureReady: boolean;
  strictMode: boolean;
}

export interface AdapterReadinessEvaluation {
  adapterType: LocalAdapterAssuranceType;
  status: AdapterReadinessStatus;
  basicReady: boolean;
  operationalReady: boolean;
  fixtureReady: boolean;
  reasonCodes: AdapterReadinessReasonCode[];
  strictMode: boolean;
  executionBlocked: boolean;
}

export function evaluateAdapterReadiness(input: EvaluateAdapterReadinessInput): AdapterReadinessEvaluation {
  const reasonCodes: AdapterReadinessReasonCode[] = [];

  if (!input.cliFound) reasonCodes.push("binary_missing");
  if (!input.authOk) reasonCodes.push("auth_failed");
  if (!input.modelOk) reasonCodes.push("model_missing");
  if (!input.workspaceOk) reasonCodes.push("workspace_invalid");
  if (input.helloRunOk === false) reasonCodes.push("hello_failed");
  if (!input.fixtureReady) reasonCodes.push("fixture_run_missing");
  reasonCodes.push(...input.operationalWarnings);

  const basicReady =
    input.cliFound &&
    input.authOk &&
    input.modelOk &&
    input.workspaceOk &&
    input.helloRunOk !== false;
  const operationalReady = basicReady && input.operationalWarnings.length === 0;
  const executionBlocked = shouldBlockAgentExecutionForReadiness({
    basicReady,
    operationalReady,
    strictMode: input.strictMode,
  });
  const status: AdapterReadinessStatus = statusFor(
    basicReady,
    operationalReady,
    input.fixtureReady,
    input.strictMode,
  );

  return {
    adapterType: input.adapterType,
    status,
    basicReady,
    operationalReady,
    fixtureReady: input.fixtureReady,
    reasonCodes: Array.from(new Set(reasonCodes)),
    strictMode: input.strictMode,
    executionBlocked,
  };
}

export function shouldBlockAgentExecutionForReadiness(
  input: Pick<AdapterReadinessEvaluation, "basicReady" | "operationalReady" | "strictMode">,
): boolean {
  if (!input.basicReady) return true;
  if (input.strictMode && !input.operationalReady) return true;
  return false;
}

export function assertCanStartAgentWithReadiness(input: {
  basicReady: boolean;
  operationalReady: boolean;
  strictMode: boolean;
  reasonCodes: string[];
}): void {
  if (!input.basicReady || (input.strictMode && !input.operationalReady)) {
    throw new Error(`Adapter readiness blocks execution: ${input.reasonCodes.join(", ") || "unknown"}`);
  }
}

function statusFor(
  basicReady: boolean,
  operationalReady: boolean,
  fixtureReady: boolean,
  strictMode: boolean,
): AdapterReadinessStatus {
  if (!basicReady) return "blocked";
  if (strictMode && !operationalReady) return "blocked";
  if (!operationalReady || !fixtureReady) return "warning";
  return "ready";
}

type AdapterReadinessProbeInput = {
  adapterType: LocalAdapterAssuranceType;
  strictMode: boolean;
  checkedByUserId: string | null;
};

type AgentWorkRole = EvaluateModelAssuranceInput["agentRole"];

async function assertAgentBelongsToCompany(db: Db, companyId: string, agentId: string): Promise<void> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1);

  if (!agent) {
    throw notFound("Agent not found");
  }
}

function selectedModelFromConfig(config: Record<string, unknown>): string | null {
  const model = config.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function workRoleForAgent(agent: { role: string; title: string | null; capabilities: string | null }): AgentWorkRole {
  const searchable = [agent.role, agent.title, agent.capabilities].filter(Boolean).join(" ").toLowerCase();
  if (/(engineer|developer|implementation|code|software)/.test(searchable)) return "engineering";
  if (/(research|insight|citation|analysis)/.test(searchable)) return "research";
  if (/(ceo|founder|governance|strategy|board)/.test(searchable)) return "governance";
  if (/(support|ops|operation|runbook)/.test(searchable)) return "operations";
  if (/(finance|budget|cost)/.test(searchable)) return "finance";
  return "utility";
}

export function adapterReadinessService(db: Db) {
  return {
    getLatestForAgent: async (companyId: string, agentId: string) => {
      await assertAgentBelongsToCompany(db, companyId, agentId);

      const [row] = await db
        .select()
        .from(adapterReadinessProbes)
        .where(
          and(
            eq(adapterReadinessProbes.companyId, companyId),
            eq(adapterReadinessProbes.agentId, agentId),
            or(isNull(adapterReadinessProbes.expiresAt), gt(adapterReadinessProbes.expiresAt, new Date())),
          ),
        )
        .orderBy(desc(adapterReadinessProbes.createdAt))
        .limit(1);

      return row ?? null;
    },

    probeAgent: async (companyId: string, agentId: string, input: AdapterReadinessProbeInput) => {
      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
        .limit(1);

      if (!agent) {
        throw notFound("Agent not found");
      }
      if (agent.adapterType !== input.adapterType) {
        throw badRequest("Probe adapter type does not match agent adapter type");
      }

      const adapter = findActiveServerAdapter(input.adapterType);
      const selectedModel = selectedModelFromConfig(agent.adapterConfig);
      const knownModels = adapter?.models ?? [];
      const modelProfiles = (adapter?.modelProfiles ?? []) as AdapterModelProfileDefinition[];
      const modelAssurance = evaluateModelAssurance({
        adapterType: input.adapterType,
        agentRole: workRoleForAgent(agent),
        selectedModel,
        knownModels,
        detectedModel: null,
        modelProfiles,
        helloRunSucceeded: null,
      });
      const modelOk = modelAssurance.policyStatus !== "blocked";
      const operationalWarnings: AdapterReadinessReasonCode[] =
        input.adapterType === "agy_local"
          ? ["quota_unknown"]
          : adapter?.getQuotaWindows
            ? []
            : ["quota_unknown"];
      const evaluation = evaluateAdapterReadiness({
        adapterType: input.adapterType,
        cliFound: Boolean(adapter),
        authOk: Boolean(adapter),
        modelOk,
        workspaceOk: true,
        helloRunOk: adapter ? null : false,
        operationalWarnings,
        fixtureReady: false,
        strictMode: input.strictMode,
      });

      const [row] = await db
        .insert(adapterReadinessProbes)
        .values({
          companyId,
          agentId,
          adapterType: input.adapterType,
          status: evaluation.status,
          basicReady: evaluation.basicReady,
          operationalReady: evaluation.operationalReady,
          fixtureReady: evaluation.fixtureReady,
          reasonCodesJson: evaluation.reasonCodes,
          model: modelAssurance.selectedModel,
          resolvedModel: modelAssurance.resolvedModel,
          modelSource: modelAssurance.modelSource,
          modelProfile: modelAssurance.modelProfile,
          modelAvailable: modelAssurance.modelAvailable,
          modelRunnable: modelAssurance.modelRunnable,
          modelPolicyStatus: modelAssurance.policyStatus,
          roleFit: modelAssurance.roleFit,
          roleFitReason: modelAssurance.roleFitReason,
          modelReasonCodesJson: modelAssurance.reasonCodes,
          modelCapabilitiesJson: modelAssurance.capabilities,
          workspaceStatus: "ok",
          helloRunStatus: adapter ? "not_executed" : "adapter_missing",
          strictMode: input.strictMode,
          checkedByUserId: input.checkedByUserId,
          expiresAt: computeProbeExpiresAt(),
        })
        .returning();

      return row;
    },
  };
}
