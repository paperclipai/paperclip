import type { AiConnectionBinding } from "../../packages/shared/src/ai-connections.js";
import { verifyInstalledDaytonaPlugin } from "./installed-daytona-plugin.js";
import { NATIVE_COMPLETION_BUDGET_CENTS } from "./native-completion-defaults.js";
import path from "node:path";
import { installedReleaseDaytonaPlugin } from "./installed-release.js";
import { isManagedHiringCase } from "./chat-cases.js";
import { FixtureRegistry } from "./fixture-registry.js";
import { isImmutableDaytonaImage } from "./catalog.js";
import { TASK_TITLE_BUDGET_CENTS } from "./task-titles.js";
import { CHAT_FEATURE_SUITE, CHAT_FEATURE_BUDGET_CENTS } from "./chat-feature-cases.js";
import { codexSubscriptionAgentConfig, stageCodexSubscriptionFixture } from "./codex-subscription-fixture.js";
import { caseReceiptTask, CASE_RECEIPT_BUDGET_CENTS, CASE_RECEIPT_RUN_TIMEOUT_MS } from "./case-receipt-cases.js";
import { stageGrokSubscriptionFixture } from "./grok-subscription-fixture.js";
import type { RunnerApi } from "./api.js";
import type {
  CredentialName,
  MatrixExecution,
  SecretReference,
  SecretReferenceMap,
  RunnerE2ERuntimeUsage,
} from "./types.js";

interface CompanyRecord {
  id: string;
  issuePrefix?: string | null;
  name: string;
}

interface SecretRecord {
  id: string;
}
interface PluginRecord {
  id: string;
  pluginKey: string;
  status: string;
}
interface EnvironmentRecord {
  id: string;
  driver: string;
  config?: Record<string, unknown>;
}
interface AgentRecord {
  id: string;
  name: string;
  companyId: string;
}
interface ManagedAccountFixture {
  connectionId: string;
  binding: AiConnectionBinding;
}

interface ProjectRecord {
  id: string;
  name: string;
  primaryWorkspace?: {
    id: string;
    cwd?: string | null;
  } | null;
}

export interface LiveFixtureValues {
  company: CompanyRecord;
  secretRefs: SecretReferenceMap;
  environment: EnvironmentRecord;
  agent: AgentRecord;
  project?: ProjectRecord;
  aiConnection?: ManagedAccountFixture;
  setupProbe?: { leaseId: string; durationMs: number; defaultRunner?: string };
  setupLeases?: Array<{ leaseId: string; phase: "platform" | "adapter"; durationMs: number }>;
  setupLeaseAccountingIncomplete?: boolean;
  setupQualification?: { recorded: boolean; adapterType: string | null; platformResponses: number; adapterResponses: number };

  onboardingRuntime?: {
    mode: "production-wizard" | "post-onboarding-runtime-switch";
    originalAdapterType: string;
    originalModel: string | null;
    testedAdapterType: string;
  };
  teardown(): Promise<void>;
}

function value<T>(resolved: ReadonlyMap<string, unknown>, id: string): T {
  const result = resolved.get(id);
  if (!result) throw new Error(`Missing resolved fixture ${id}`);
  return result as T;
}

export function selectFixtureRuntimeLeases<T extends {
  id: string; provider?: string | null; heartbeatRunId?: string | null; issueId?: string | null;
}>(input: { leases: T[]; runIds: string[]; issueId?: string; setupProbeLeaseId?: string; setupLeaseIds?: readonly string[] }): T[] {
  const selectedRunIds = new Set(input.runIds);
  const setupIds = new Set([...(input.setupLeaseIds ?? []), ...(input.setupProbeLeaseId ? [input.setupProbeLeaseId] : [])]);
  const relevant = input.leases.filter(lease => lease.provider === "daytona" && (
    setupIds.has(lease.id) || (input.setupLeaseIds === undefined && selectedRunIds.size === 0)
    || (lease.heartbeatRunId && selectedRunIds.has(lease.heartbeatRunId))
    || (input.issueId && lease.issueId === input.issueId)
  ));
  return input.setupLeaseIds !== undefined || relevant.length > 0 ? relevant : input.leases;
}

export function fixtureRuntimeCostCoverage(usage: RunnerE2ERuntimeUsage, fixtures: Pick<LiveFixtureValues, "setupLeaseAccountingIncomplete">): RunnerE2ERuntimeUsage {
  if (!fixtures.setupLeaseAccountingIncomplete) return usage;
  const { estimatedListCostUsd: _estimate, ...known } = usage;
  return { ...known, costStatus: "unavailable", costSource: "provider_cost_unavailable" };
}

export async function deleteDaytonaEnvironment(api: Pick<RunnerApi, "delete">, environmentId: string) {
  const deadlineAt = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadlineAt) {
    try {
      await api.delete(
        `/api/environments/${environmentId}?destroyReusableSandboxLeases=true`,
        {
          allowNotFound: true,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  throw new Error(
    `Daytona lease cleanup failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function installFixtureDaytonaProvider(api: Pick<RunnerApi, "post">, execution: MatrixExecution) {
  const installed = await verifyInstalledDaytonaPlugin(process.env, [execution]);
  return api.post<PluginRecord>("/api/plugins/install", {
    packageName: installed?.packageRoot ?? path.resolve(import.meta.dirname, "../../packages/plugins/sandbox-providers/daytona"),
    isLocalPath: true,
  }, { timeout: 120_000 });
}

export async function setupLiveFixtures(input: {
  api: RunnerApi;
  execution: MatrixExecution;
  executionNonce: string;
  workspacePath: string;
  credentials: Partial<Record<CredentialName, string>>;
  daytonaImage?: string;
  onCompanyCreated?: (companyId: string) => Promise<void>;
}): Promise<LiveFixtureValues> {
  const { api, execution } = input;
  const receiptSmoke = execution.suite.id === "case-handoffs" && execution.task.id === caseReceiptTask.id;
  const registry = new FixtureRegistry();
  let setupProbe: LiveFixtureValues["setupProbe"];

  if (execution.environment.id === "daytona") {
    registry.register<PluginRecord>({
      id: "sandbox-provider",
      async setup() {
        return installFixtureDaytonaProvider(api, execution);
      },
      async teardown() {
        // The plugin is installed only in the isolated instance/database. The
        // launcher removes that complete instance after the environment lease
        // has been destroyed, so no global uninstall mutation is necessary.
      },
    });
  }

  registry.register<CompanyRecord>({
    id: "company",
    async setup() {
      const company = await api.post<CompanyRecord>("/api/companies", {
        name: `Runner E2E ${execution.id} ${input.executionNonce}`,
        description: "Ephemeral paid full-stack runner acceptance fixture",
        budgetMonthlyCents: execution.suite.id === CHAT_FEATURE_SUITE ? CHAT_FEATURE_BUDGET_CENTS
          : receiptSmoke ? CASE_RECEIPT_BUDGET_CENTS
          : ["native-completion", "native-instruction-consolidation", "native-connection-guidance"].includes(execution.suite.id)
          || (execution.suite.id === "everyday-workflows" && ["hire-reuse", "delegate-feedback"].includes(execution.task.id)) ? NATIVE_COMPLETION_BUDGET_CENTS
          : execution.suite.id === "task-titles" ? TASK_TITLE_BUDGET_CENTS
          : ["stock-harness", "task-workspaces", "case-handoffs", "feedback-persistence", "daytona-restart-continuity"].includes(execution.suite.id) ? 1_000 : 0,
      });
      await input.onCompanyCreated?.(company.id);
      return company;
    },
    async teardown() {
      // The isolated instance/database is removed by the launcher. Do not call
      // company deletion here: metered runs intentionally retain cost-event
      // references until that instance-wide teardown.
    },
  });

  registry.register<SecretReferenceMap>({
    id: "secrets",
    dependencies: ["company"],
    async setup(resolved) {
      const company = value<CompanyRecord>(resolved, "company");
      const refs: SecretReferenceMap = {};
      for (const credentialName of execution.requiredCredentials) {
        if (["GROK_AUTH_JSON", "CODEX_AUTH_JSON"].includes(credentialName)) continue;
        const rawValue = input.credentials[credentialName];
        if (!rawValue) throw new Error(`Missing credential ${credentialName}`);
        const secret = await api.postSensitive<SecretRecord>(
          `/api/companies/${company.id}/secrets`,
          {
            name: `Runner E2E ${credentialName} ${input.executionNonce}`,
            key: credentialName,
            value: rawValue,
            description: `Ephemeral credential for ${execution.id}`,
          },
        );
        refs[credentialName] = {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        } satisfies SecretReference;
      }
      return refs;
    },
  });

  const grokSubscription = execution.profile.credential === "GROK_AUTH_JSON";
  const codexSubscription = execution.profile.credential === "CODEX_AUTH_JSON";
  if (grokSubscription || codexSubscription) {
    registry.register<() => Promise<void>>({
      id: "subscription-login",
      dependencies: ["company"],
      async setup(resolved) {
        const raw = input.credentials[execution.profile.credential];
        if (!raw) throw new Error("Missing explicit subscription login credential");
        return (codexSubscription ? stageCodexSubscriptionFixture : stageGrokSubscriptionFixture)({
          raw, companyId: value<CompanyRecord>(resolved, "company").id,
          environment: process.env,
        });
      },
      async teardown(remove) { await remove(); },
    });
  }

  registry.register<EnvironmentRecord>({
    id: "environment",
    dependencies: [
      "company",
      "secrets",
      ...((grokSubscription || codexSubscription) ? ["subscription-login"] : []),
      ...(execution.environment.id === "daytona" ? ["sandbox-provider"] : []),
    ],
    async setup(resolved) {
      const company = value<CompanyRecord>(resolved, "company");
      const secretRefs = value<SecretReferenceMap>(resolved, "secrets");
      if (execution.environment.id === "local") {
        // Paperclip has one instance-managed local environment. The company
        // creation API ensures it exists; creating a second local environment
        // is intentionally rejected by the public API.
        const environments = await api.get<EnvironmentRecord[]>(
          `/api/companies/${company.id}/environments?driver=local`,
        );
        const local = environments.find(
          (candidate) => candidate.driver === "local",
        );
        if (!local)
          throw new Error(
            "Isolated Paperclip instance did not create its managed local environment",
          );
        return local;
      }
      return api.post<EnvironmentRecord>(
        `/api/companies/${company.id}/environments`,
        execution.environment.buildEnvironment({
          secretRefs,
          daytonaImage: input.daytonaImage,
          executionId: input.executionNonce,
        }),
      );
    },
    async teardown(environment) {
      if (execution.environment.id === "daytona") {
        await deleteDaytonaEnvironment(api, environment.id);
      }
    },
  });

  const managedHiring = isManagedHiringCase(execution.suite.id, execution.task.id);
  const savedCopilot = execution.profile.qualificationCandidate === "copilot";
  const gatewayUrl = process.env.PAPERCLIP_E2E_GATEWAY_BASE_URL;
  const gatewayToken = process.env.PAPERCLIP_E2E_GATEWAY_TOKEN;
  const budgetedGateway = Boolean(gatewayUrl || gatewayToken);
  if (budgetedGateway && (!gatewayUrl || !gatewayToken || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(gatewayUrl)
      || execution.environment.id !== "local" || !["core-compatibility", "feedback-persistence"].includes(execution.suite.id))) throw new Error("Unqualified fixture gateway route");
  if (managedHiring || savedCopilot || budgetedGateway) {
    registry.register<ManagedAccountFixture>({
      id: "ai-connection",
      dependencies: ["company", ...(savedCopilot ? ["environment"] : [])],
      async setup(resolved) {
        const company = value<CompanyRecord>(resolved, "company");
        const key = savedCopilot ? "COPILOT_GITHUB_TOKEN" : execution.profile.credential;
        const provider = savedCopilot ? "github" : key === "ANTHROPIC_API_KEY" ? "anthropic"
          : key === "OPENROUTER_API_KEY" ? "openrouter"
          : key === "OPENAI_API_KEY" ? "openai" : null;
        if (!provider) throw new Error(`Unsupported managed hiring credential ${key}`);
        const apiKey = input.credentials[key];
        if (!apiKey) throw new Error(`Missing credential ${key}`);
        const account = await api.postSensitive<{ connectionId: string; grantId: string }>(
          `/api/companies/${company.id}/ai-connections`,
          {
            provider,
            method: "api_key",
            name: `Runner E2E account ${input.executionNonce}`,
            ownership: budgetedGateway ? "shared" : "personal",
            ...(budgetedGateway ? { routing: { kind: "gateway", protocol: provider === "anthropic" ? "messages" : "responses",
              baseUrl: provider === "anthropic" ? gatewayUrl : `${gatewayUrl}/v1`, auth: "bearer", models: [{ id: execution.profile.model }] } } : {}),
            ...(savedCopilot ? { environmentId: value<EnvironmentRecord>(resolved, "environment").id } : {}),
            apiKey: budgetedGateway ? gatewayToken : apiKey,
            agentIds: [],
            allAgents: budgetedGateway,
          },
        );
        return {
          connectionId: account.connectionId,
          binding: budgetedGateway
            ? { provider, method: "api_key", mode: "shared", connectionId: account.connectionId, grantId: account.grantId }
            : { provider, method: "api_key", mode: "responsible_user" },
        };
      },
    });
  }

  registry.register<AgentRecord>({
    id: "agent",
    dependencies: [
      "company",
      "secrets",
      "environment",
      ...((grokSubscription || codexSubscription) ? ["subscription-login"] : []),
      ...(managedHiring || savedCopilot || budgetedGateway ? ["ai-connection"] : []),
    ],
    async setup(resolved) {
      const company = value<CompanyRecord>(resolved, "company");
      const environment = value<EnvironmentRecord>(resolved, "environment");
      const secretRefs = value<SecretReferenceMap>(resolved, "secrets");
      const agent = execution.profile.buildAgent({
        environmentId: environment.id,
        environmentFixtureId: execution.environment.id,
        workspacePath: input.workspacePath,
        secretRefs,
        executionId: input.executionNonce,
      });
      const autoCodex = agent.adapterType === "codex_local" && (agent.runner === undefined || agent.runner === "auto");
      const nativeCodex = agent.adapterType === "paperclip_runner" && (agent.adapterConfig as Record<string, unknown>).provider === "codex";
      if (environment.driver === "sandbox" && execution.profile.generation === "native"
        && execution.profile.provider === "codex" && agent.runner !== "legacy" && (autoCodex || nativeCodex)) {
        if (!isImmutableDaytonaImage(String(environment.config?.image ?? "")) || environment.config?.snapshot) {
          throw new Error("Native Codex qualification requires this fixture's immutable image-backed environment.");
        }
        const startedAt = Date.now();
        const probe = await api.post<{ ok: boolean; details?: { platformQualificationRecorded?: boolean; leaseId?: string } }>(
          `/api/environments/${environment.id}/probe?companyId=${encodeURIComponent(company.id)}`,
          {}, { timeout: 330_000 },
        );
        if (probe.ok !== true || probe.details?.platformQualificationRecorded !== true || !probe.details.leaseId) {
          throw new Error("Native Codex image qualification was not recorded; agent creation was not attempted.");
        }
        setupProbe = { leaseId: probe.details.leaseId, durationMs: Date.now() - startedAt };
        if (autoCodex) {
          const adapters = await api.get<Array<{ type: string; defaultRunner?: string; supportedRunners?: string[] }>>(
            `/api/adapters?companyId=${encodeURIComponent(company.id)}&environmentId=${encodeURIComponent(environment.id)}`,
          );
          const selected = adapters.find(adapter => adapter.type === "codex_local");
          if (selected?.defaultRunner !== "paperclip" || !selected.supportedRunners?.includes("paperclip")) {
            throw new Error("The qualified image does not advertise native Codex as its server-owned default.");
          }
          setupProbe.defaultRunner = selected.defaultRunner;
        }
      }
      if (["stock-harness", "native-connection-guidance", "feedback-persistence", "daytona-restart-continuity"].includes(execution.suite.id)
        || (execution.suite.id === "everyday-workflows" && ["hire-reuse", "delegate-feedback"].includes(execution.task.id))) {
        agent.budgetMonthlyCents = 1_000;
      }
      if (receiptSmoke) {
        agent.budgetMonthlyCents = CASE_RECEIPT_BUDGET_CENTS;
        agent.adapterConfig = { ...(agent.adapterConfig as Record<string, unknown>),
          timeoutSec: CASE_RECEIPT_RUN_TIMEOUT_MS / 1_000, modelReasoningEffort: "low" };
        const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
        agent.runtimeConfig = { ...runtimeConfig,
          heartbeat: { ...((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>),
            enabled: false, maxConcurrentRuns: 1, maxDailyRuns: 1, maxDailyCostCents: CASE_RECEIPT_BUDGET_CENTS } };
      }
      if (managedHiring || savedCopilot || budgetedGateway) {
        const account = value<ManagedAccountFixture>(resolved, "ai-connection");
        const config = agent.adapterConfig as Record<string, unknown>;
        delete config.env;
        agent.runtimeConfig = {
          ...(agent.runtimeConfig as Record<string, unknown>),
          aiConnection: account.binding,
        };
      }
      return api.post<AgentRecord>(
        `/api/companies/${company.id}/agents`,
        codexSubscription ? codexSubscriptionAgentConfig(agent, process.env, company.id) : agent,
      );
    },
    async teardown() {
      // Agent state is instance-local. Daytona environment teardown below is
      // the only fixture cleanup that must reach an external provider.
    },
  });

  if (execution.task.flow === "repository_verification"
    || execution.task.flow === "finalization_recovery"
    || execution.task.flow === "followup_stop_resume"
    || execution.task.flow === "warm_three_turn"
    || (execution.suite.id === "extended-harnesses" && execution.task.id === "file-edit-validate")) {
    registry.register<ProjectRecord>({
      id: "project",
      dependencies: ["company", "environment"],
      async setup(resolved) {
        const company = value<CompanyRecord>(resolved, "company");
        const environment = value<EnvironmentRecord>(resolved, "environment");
        return api.post<ProjectRecord>(
          `/api/companies/${company.id}/projects`,
          {
            name: `Runner E2E workspace project ${input.executionNonce}`,
            description:
              "Ephemeral project anchoring the fixture execution workspace and file copy-back",
            executionWorkspacePolicy: {
              enabled: true,
              defaultMode: "shared_workspace",
              sharedWorkspaceConcurrency: "serialize",
              allowIssueOverride: false,
              environmentId: environment.id,
              workspaceStrategy: { type: "project_primary" },
            },
            workspace: {
              name: "Primary",
              sourceType: "local_path",
              cwd: input.workspacePath,
              isPrimary: true,
            },
          },
        );
      },
      async teardown() {
        // The isolated instance is deleted after provider resources are gone.
      },
    });
  }

  const setup = await registry.setupAll();
  return {
    company: value<CompanyRecord>(setup.values, "company"),
    secretRefs: value<SecretReferenceMap>(setup.values, "secrets"),
    environment: value<EnvironmentRecord>(setup.values, "environment"),
    agent: value<AgentRecord>(setup.values, "agent"),
    ...(setupProbe ? { setupProbe } : {}),
    ...(setup.values.has("project")
      ? { project: value<ProjectRecord>(setup.values, "project") }
      : {}),
    ...(managedHiring
      ? {
          aiConnection: value<ManagedAccountFixture>(
            setup.values,
            "ai-connection",
          ),
        }
      : {}),
    teardown: setup.teardown,
  };
}
