import type { Db } from "@paperclipai/db";
import { adapterReadinessProbes, agents } from "@paperclipai/db";
import {
  modelAssuranceModelSourceSchema,
  modelAssurancePolicyStatusSchema,
  modelAssuranceReasonCodeSchema,
  modelAssuranceRoleFitSchema,
  type ModelAssuranceReasonCode,
  type ModelAssuranceSummary,
} from "@paperclipai/shared";
import type { AdapterModel, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { notFound } from "../../errors.js";

type AgentWorkRole = "engineering" | "research" | "governance" | "operations" | "finance" | "utility";

export interface EvaluateModelAssuranceInput {
  adapterType: string;
  agentRole: AgentWorkRole;
  selectedModel: string | null | undefined;
  knownModels: AdapterModel[];
  detectedModel: string | null;
  modelProfiles: AdapterModelProfileDefinition[];
  helloRunSucceeded: boolean | null;
}

function normalizedString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function modelFromProfile(profile: AdapterModelProfileDefinition): string | null {
  const model = profile.adapterConfig.model;
  return typeof model === "string" ? normalizedString(model) : null;
}

function isCheapProfileModel(model: string | null, profiles: AdapterModelProfileDefinition[]): boolean {
  if (!model) return false;
  return profiles.some((profile) => profile.key === "cheap" && modelFromProfile(profile) === model);
}

function hasUsableCheapProfile(profiles: AdapterModelProfileDefinition[]): boolean {
  return profiles.some((profile) => profile.key === "cheap" && Boolean(modelFromProfile(profile)));
}

function violatesAgyModelPolicy(adapterType: string, model: string | null): boolean {
  return adapterType === "agy_local" && model !== null && model !== "gemini-3.5-flash";
}

function roleFitFor(
  adapterType: string,
  role: AgentWorkRole,
  model: string | null,
  profiles: AdapterModelProfileDefinition[],
): Pick<ModelAssuranceSummary, "roleFit" | "roleFitReason"> {
  if (!model) {
    return { roleFit: "unknown", roleFitReason: "Model could not be resolved." };
  }

  const cheap = isCheapProfileModel(model, profiles);
  if (violatesAgyModelPolicy(adapterType, model)) {
    return {
      roleFit: "blocked",
      roleFitReason: "AGY MVP certification only allows gemini-3.5-flash.",
    };
  }
  if (cheap && (role === "governance" || role === "research")) {
    return {
      roleFit: "blocked",
      roleFitReason: "Cheap profile cannot make governed or material evidence decisions.",
    };
  }
  if (adapterType === "codex_local" && role === "engineering") {
    return { roleFit: "strong", roleFitReason: null };
  }
  if (adapterType === "agy_local" && role === "research") {
    return { roleFit: "strong", roleFitReason: null };
  }
  if (adapterType === "claude_local" && ["governance", "operations", "finance"].includes(role)) {
    return { roleFit: "strong", roleFitReason: null };
  }
  if (cheap) {
    return {
      roleFit: "acceptable",
      roleFitReason: "Cheap profile is acceptable for bounded low-risk utility work.",
    };
  }
  return { roleFit: "acceptable", roleFitReason: null };
}

export function evaluateModelAssurance(input: EvaluateModelAssuranceInput): ModelAssuranceSummary {
  const selected = normalizedString(input.selectedModel);
  const detected = normalizedString(input.detectedModel);
  const resolved = selected ?? detected;
  const known = Boolean(resolved && input.knownModels.some((model) => model.id === resolved));
  const manualAllowed = input.adapterType === "codex_local" && Boolean(selected) && !known;
  const reasonCodes: ModelAssuranceReasonCode[] = [];

  if (!resolved) reasonCodes.push("model_unresolved");
  if (resolved && !known) reasonCodes.push("model_not_listed");
  if (input.helloRunSucceeded === false && !manualAllowed) reasonCodes.push("model_hello_failed");
  if (manualAllowed && !input.helloRunSucceeded) reasonCodes.push("manual_model_unverified");
  if (!hasUsableCheapProfile(input.modelProfiles)) reasonCodes.push("cheap_profile_missing");

  const fit = roleFitFor(input.adapterType, input.agentRole, resolved, input.modelProfiles);
  if (fit.roleFit === "blocked" || fit.roleFit === "weak") reasonCodes.push("role_fit_weak");
  if (violatesAgyModelPolicy(input.adapterType, resolved)) reasonCodes.push("cost_policy_blocked");

  const blocked =
    fit.roleFit === "blocked" ||
    (!resolved && !manualAllowed) ||
    (input.helloRunSucceeded === false && !manualAllowed);
  const cheapProfileSelected = isCheapProfileModel(resolved, input.modelProfiles);
  const policyStatus = blocked
    ? "blocked"
    : manualAllowed
      ? "manual_allowed"
      : resolved && !known
        ? "warning"
        : !input.helloRunSucceeded
        ? "warning"
        : cheapProfileSelected
          ? "approved_cheap"
          : selected
            ? "approved_primary"
            : "approved_default";

  return {
    selectedModel: selected,
    resolvedModel: resolved,
    modelSource: selected ? "adapter_config" : detected ? "detected" : "unknown",
    modelProfile: cheapProfileSelected ? "cheap" : resolved ? "primary" : null,
    modelAvailable: known,
    modelRunnable: input.helloRunSucceeded === true,
    policyStatus,
    roleFit: fit.roleFit,
    roleFitReason: fit.roleFitReason,
    reasonCodes: Array.from(new Set(reasonCodes)),
    capabilities: null,
  };
}

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

export function modelAssuranceService(db: Db) {
  const service = {
    getLatestForAgent: async (companyId: string, agentId: string): Promise<ModelAssuranceSummary | null> => {
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

      if (!row) return null;
      const modelSource = modelAssuranceModelSourceSchema.safeParse(row.modelSource);
      const policyStatus = modelAssurancePolicyStatusSchema.safeParse(row.modelPolicyStatus);
      const roleFit = modelAssuranceRoleFitSchema.safeParse(row.roleFit);
      const reasonCodes = Array.isArray(row.modelReasonCodesJson)
        ? row.modelReasonCodesJson.filter((code): code is ModelAssuranceReasonCode => {
          return modelAssuranceReasonCodeSchema.safeParse(code).success;
        })
        : [];

      return {
        selectedModel: row.model,
        resolvedModel: row.resolvedModel,
        modelSource: modelSource.success ? modelSource.data : "unknown",
        modelProfile: row.modelProfile,
        modelAvailable: row.modelAvailable,
        modelRunnable: row.modelRunnable,
        policyStatus: policyStatus.success ? policyStatus.data : "unknown",
        roleFit: roleFit.success ? roleFit.data : "unknown",
        roleFitReason: row.roleFitReason,
        reasonCodes,
        capabilities: row.modelCapabilitiesJson,
      };
    },

    probeAgent: async (companyId: string, agentId: string): Promise<ModelAssuranceSummary | null> => {
      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
        .limit(1);
      if (!agent) {
        throw notFound("Agent not found");
      }

      return service.getLatestForAgent(companyId, agentId);
    },
  };

  return service;
}
