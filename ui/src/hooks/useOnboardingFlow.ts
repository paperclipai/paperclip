// Backend orchestration for onboarding, extracted from OnboardingWizard so a
// new presentational onboarding flow can reuse the exact company/goal/agent/
// issue creation logic without duplicating API calls or query invalidation.
//
// This hook owns the "created entity" ids and the adapter-environment probe
// state; it does NOT own user-entered form state (company name, mission, agent
// name, adapter selection) — callers pass those into the action functions. It
// also does not navigate: launchFirstTask returns the target company prefix and
// lets the caller route, keeping routing a UI concern.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { companiesApi } from "@/api/companies";
import { goalsApi } from "@/api/goals";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { parseOnboardingGoalInput } from "@/lib/onboarding-goal";
import { composeCeoInstructions } from "@/lib/ceo-instructions";
import { buildNewAgentRuntimeConfig } from "@/lib/new-agent-runtime-config";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId,
  selectReusableOnboardingProject,
} from "@/lib/onboarding-launch";
import {
  buildOnboardingAdapterConfig,
  type OnboardingAdapterConfigInput,
} from "@/lib/onboarding-adapter-config";
import {
  DEFAULT_TASK_DESCRIPTION,
  DEFAULT_TASK_TITLE,
} from "@/lib/onboarding-constants";

/** Adapter selection inputs shared by the env probe and the hire action. */
export type AdapterInput = Omit<OnboardingAdapterConfigInput, "forceUnsetAnthropicApiKey">;

/** Context used to seed the lead agent's instructions file. */
export interface OnboardingInstructionsContext {
  companyName: string;
  companyGoal: string;
  growPath: boolean;
  growWorkflows: string;
  growPainPoints: string;
  growAutomate: string;
  q1: string;
  q2: string;
  q3: string;
  q4: string;
}

export interface HireLeadAgentInput {
  agentName: string;
  adapter: AdapterInput;
  instructions: OnboardingInstructionsContext;
  /**
   * When true (local adapters), require a successful adapter-environment probe
   * before hiring. Mirrors the wizard: hire is aborted only if the probe cannot
   * run at all (returns null), not if it returns a fail status.
   */
  requireEnvProbe: boolean;
}

export interface CreatedOnboardingEntities {
  createdCompanyId: string | null;
  createdCompanyPrefix: string | null;
  createdAgentId: string | null;
  createdCompanyGoalId: string | null;
  createdProjectId: string | null;
  createdIssueRef: string | null;
}

export function useOnboardingFlow(initial?: Partial<CreatedOnboardingEntities>) {
  const queryClient = useQueryClient();
  const { setSelectedCompanyId } = useCompany();

  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    initial?.createdCompanyId ?? null,
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<string | null>(
    initial?.createdCompanyPrefix ?? null,
  );
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(
    initial?.createdAgentId ?? null,
  );
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    initial?.createdCompanyGoalId ?? null,
  );
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(
    initial?.createdProjectId ?? null,
  );
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(
    initial?.createdIssueRef ?? null,
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] = useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  /**
   * Identifies the adapter selection that produced `adapterEnvResult`. The local
   * flow lets the user pick a different adapter and retry after a failed hire,
   * so a cached probe result is only evidence about the adapter it actually
   * ran against — see `hireLeadAgent`.
   */
  const [adapterEnvProbedKey, setAdapterEnvProbedKey] = useState<string | null>(null);

  function buildAdapterConfig(adapter: AdapterInput): Record<string, unknown> {
    return buildOnboardingAdapterConfig({ ...adapter, forceUnsetAnthropicApiKey });
  }

  /**
   * Stable identity for a probe: the adapter type plus the exact config posted
   * to the environment-test endpoint. `buildOnboardingAdapterConfig` builds its
   * object in a fixed key order for a given adapter, so `JSON.stringify` is
   * stable across calls.
   */
  function adapterProbeKey(
    adapterType: string,
    adapterConfig: Record<string, unknown>,
  ): string {
    return JSON.stringify([adapterType, adapterConfig]);
  }

  /**
   * Forget any cached probe result. Callers invoke this when the user changes
   * the adapter selection, so neither the UI nor `hireLeadAgent` keeps showing
   * or trusting a verdict about the adapter that is no longer selected.
   */
  function clearAdapterEnvResult(): void {
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvProbedKey(null);
  }

  /**
   * Create the company + its company-level goal from the mission. Guarded so
   * calling it again after a company exists is a no-op that returns the
   * already-created ids.
   */
  async function createCompanyAndGoal(input: {
    companyName: string;
    companyGoal: string;
  }): Promise<{ companyId: string; companyPrefix: string; goalId: string | null } | null> {
    if (createdCompanyId) {
      return {
        companyId: createdCompanyId,
        companyPrefix: createdCompanyPrefix ?? "",
        goalId: createdCompanyGoalId,
      };
    }
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: input.companyName.trim() });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      const parsedGoal = parseOnboardingGoalInput(input.companyGoal);
      const goal = await goalsApi.create(company.id, {
        title: parsedGoal.title,
        ...(parsedGoal.description ? { description: parsedGoal.description } : {}),
        level: "company",
        status: "active",
      });
      setCreatedCompanyGoalId(goal.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(company.id) });

      return { companyId: company.id, companyPrefix: company.issuePrefix, goalId: goal.id };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function runAdapterEnvironmentTest(
    adapter: AdapterInput,
    adapterConfigOverride?: Record<string, unknown>,
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select a company before testing adapter environment.",
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    const adapterConfig = adapterConfigOverride ?? buildAdapterConfig(adapter);
    try {
      const result = await agentsApi.testEnvironment(createdCompanyId, adapter.adapterType, {
        adapterConfig,
      });
      setAdapterEnvResult(result);
      setAdapterEnvProbedKey(adapterProbeKey(adapter.adapterType, adapterConfig));
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Adapter environment test failed",
      );
      setAdapterEnvResult(null);
      setAdapterEnvProbedKey(null);
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  /**
   * Clear ANTHROPIC_API_KEY in the adapter config and re-probe. Mirrors the
   * wizard's remediation when a stray key overrides the Claude subscription.
   */
  async function unsetAnthropicApiKeyAndRetry(adapter: AdapterInput): Promise<void> {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);

    const configWithUnset = (() => {
      const config = buildAdapterConfig(adapter);
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();

    try {
      if (createdAgentId) {
        await agentsApi.update(createdAgentId, { adapterConfig: configWithUnset }, createdCompanyId);
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(createdCompanyId) });
      }

      const result = await runAdapterEnvironmentTest(adapter, configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing.",
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry.",
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  /**
   * Hire the lead agent (role: ceo), auto-approve any board approval, and seed
   * its instructions file. Guarded so a second call after an agent exists is a
   * no-op. Returns null on failure (error is set) or when a required env probe
   * cannot run.
   */
  async function hireLeadAgent(
    input: HireLeadAgentInput,
  ): Promise<{ agentId: string } | null> {
    if (!createdCompanyId) return null;
    if (createdAgentId) return { agentId: createdAgentId };

    setLoading(true);
    setError(null);
    const adapterConfig = buildAdapterConfig(input.adapter);
    try {
      if (input.requireEnvProbe) {
        // Reuse the cached probe only when it ran against this exact adapter
        // selection. After a failed hire the user can go back and pick a
        // different adapter, and the previous adapter's verdict says nothing
        // about the new one.
        const cacheHit =
          adapterEnvResult !== null &&
          adapterEnvProbedKey === adapterProbeKey(input.adapter.adapterType, adapterConfig);
        const result = cacheHit
          ? adapterEnvResult
          : await runAdapterEnvironmentTest(input.adapter, adapterConfig);
        if (!result) return null;
      }

      const hire = await agentsApi.hire(createdCompanyId, {
        name: input.agentName.trim(),
        role: "ceo",
        adapterType: input.adapter.adapterType,
        adapterConfig,
        runtimeConfig: buildNewAgentRuntimeConfig(),
      });
      if (hire.approval) {
        await approvalsApi.approve(
          hire.approval.id,
          "Approved during onboarding first-agent setup.",
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.list(createdCompanyId),
        });
      }
      const agent = hire.agent;
      setCreatedAgentId(agent.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(createdCompanyId) });

      // Seed the CEO's instructions file so the agent always has company
      // context + a hiring-plan output rule. Non-fatal on failure.
      try {
        const bundle = await agentsApi.instructionsBundle(agent.id, createdCompanyId);
        await agentsApi.saveInstructionsFile(
          agent.id,
          {
            path: bundle.entryFile,
            content: composeCeoInstructions({
              companyName: input.instructions.companyName,
              companyGoal: input.instructions.companyGoal,
              growPath: input.instructions.growPath,
              growWorkflows: input.instructions.growWorkflows,
              growPainPoints: input.instructions.growPainPoints,
              growAutomate: input.instructions.growAutomate,
              q1: input.instructions.q1,
              q2: input.instructions.q2,
              q3: input.instructions.q3,
              q4: input.instructions.q4,
            }),
          },
          createdCompanyId,
        );
      } catch (err) {
        console.warn("Failed to seed CEO instructions:", err);
      }

      return { agentId: agent.id };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      return null;
    } finally {
      setLoading(false);
    }
  }

  /**
   * Ensure the onboarding goal + project exist, create the first task assigned
   * to the lead agent, select the company, and return the target company prefix
   * for the caller to navigate to. Idempotent across the goal/project/issue it
   * creates. Requires a created company + agent.
   */
  async function launchFirstTask(input?: {
    title?: string;
    description?: string;
  }): Promise<{ companyId: string; companyPrefix: string | null } | null> {
    if (!createdCompanyId || !createdAgentId) {
      setError(
        "Onboarding state is incomplete. Please restart onboarding and try again.",
      );
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        setCreatedCompanyGoalId(goalId);
      }

      let projectId = createdProjectId;
      if (!projectId) {
        const projects = await projectsApi.list(createdCompanyId);
        const existingOnboardingProject = selectReusableOnboardingProject(projects);
        if (existingOnboardingProject) {
          projectId = existingOnboardingProject.id;
        } else {
          const project = await projectsApi.create(
            createdCompanyId,
            buildOnboardingProjectPayload(goalId),
          );
          projectId = project.id;
          queryClient.invalidateQueries({
            queryKey: queryKeys.projects.list(createdCompanyId),
          });
        }
        setCreatedProjectId(projectId);
      }

      if (!createdIssueRef) {
        const issue = await issuesApi.create(
          createdCompanyId,
          buildOnboardingIssuePayload({
            title: input?.title ?? DEFAULT_TASK_TITLE,
            description: input?.description ?? DEFAULT_TASK_DESCRIPTION,
            assigneeAgentId: createdAgentId,
            projectId,
            goalId,
          }),
        );
        setCreatedIssueRef(issue.identifier ?? issue.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(createdCompanyId),
        });
      }

      setSelectedCompanyId(createdCompanyId);
      return { companyId: createdCompanyId, companyPrefix: createdCompanyPrefix };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch first task");
      return null;
    } finally {
      setLoading(false);
    }
  }

  function setCreatedCompany(company: { id: string; prefix: string | null }) {
    setCreatedCompanyId(company.id);
    setCreatedCompanyPrefix(company.prefix);
  }

  function reset() {
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedAgentId(null);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
    setLoading(false);
    setError(null);
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setAdapterEnvProbedKey(null);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
  }

  return {
    // created entity state
    createdCompanyId,
    createdCompanyPrefix,
    createdAgentId,
    createdCompanyGoalId,
    createdProjectId,
    createdIssueRef,
    setCreatedCompany,
    setCreatedCompanyPrefix,

    // status
    loading,
    error,
    setError,

    // adapter environment probe
    adapterEnvResult,
    adapterEnvError,
    adapterEnvLoading,
    forceUnsetAnthropicApiKey,
    unsetAnthropicLoading,
    buildAdapterConfig,
    runAdapterEnvironmentTest,
    clearAdapterEnvResult,
    unsetAnthropicApiKeyAndRetry,

    // actions
    createCompanyAndGoal,
    hireLeadAgent,
    launchFirstTask,
    reset,
  };
}

export type OnboardingFlow = ReturnType<typeof useOnboardingFlow>;
