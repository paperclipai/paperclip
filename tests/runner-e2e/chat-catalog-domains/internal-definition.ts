import { chatCatalogOriginalPhaseDeadline, type ChatCatalogCase, type ChatCatalogContext } from "../chat-catalog-contract.js";
import { observeInternal, verifyInternalResult, type Entity, type InternalObservation } from "./internal-support.js";
import { codexSubscriptionAgentConfig } from "../codex-subscription-fixture.js";
import { pollUntil } from "../api.js";
export function makeDefinition(scenarioId: string, setup: ChatCatalogCase["setup"], grade: ChatCatalogCase["grade"]): ChatCatalogCase {
  const coverageGaps = scenarioId === "goals.align-existing-work" ? ["cross-company-goal-rejection"]
    : scenarioId === "goals.explain-purpose" ? ["missing-association", "inaccessible-goal-nondisclosure"]
    : scenarioId === "documents-artifacts.restore-document" ? ["concurrent-edit-conflict"]
    : scenarioId === "tasks.edit-properties" ? ["execution-ownership-denied"] : [];
  return { scenarioId, setup, coverageGaps, sourceFiles: ["chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", `chat-catalog-domains/internal-${scenarioId.split(".")[0]}.ts`, `chat-scenarios/${scenarioId.split(".")[0]}.yaml`],
    oracleVersion: "paperclip.chat-catalog.internal.v1", expectedRunCount: 1, verifyResult: verifyInternalResult, turnTimeoutMs: 120_000, attemptTimeoutMs: 300_000, observe: observeInternal, grade };
}

export async function fixtureWorker(ctx: ChatCatalogContext) {
  const originalDeadline = chatCatalogOriginalPhaseDeadline(ctx);
  const { execution, fixtures, workspacePath, nonce, api } = ctx.input;
  const base = execution.profile.buildAgent({ environmentId: fixtures.environment.id, environmentFixtureId: execution.environment.id,
    workspacePath, secretRefs: fixtures.secretRefs, executionId: nonce });
  const payload = { ...base, name: "Morgan", role: "engineer", title: "Frontend engineer", reportsTo: fixtures.agent.id,
    capabilities: "Builds accessible websites.", runtimeConfig: { ...(base.runtimeConfig as Record<string, unknown>), heartbeat: { enabled: false, maxConcurrentRuns: 1 } } };
  const worker = await api.post<Entity>(`/api/companies/${fixtures.company.id}/agents`, execution.profile.credential === "CODEX_AUTH_JSON"
    ? codexSubscriptionAgentConfig(payload, process.env, fixtures.company.id) : payload);
  const deadlineAt = originalDeadline ?? Date.now() + 45_000;
  const observations: Record<string, unknown>[] = [];
  let previous: string | undefined;
  try {
    await pollUntil({ label: "Morgan runtime readiness", deadlineAt,
      load: async () => {
        const row = await api.get<{ id: string; companyId: string; lifecycleState: string; status?: string; lifecycleError?: string | null }>(`/api/agents/${worker.id}`,
          { timeout: Math.max(1, Math.min(5_000, deadlineAt - Date.now())) });
        const state = { id: row.id, companyId: row.companyId, lifecycleState: row.lifecycleState, status: row.status,
          errorPresent: !!row.lifecycleError,
          automaticRecovery: /\b(?:Paperclip will|It will) retry automatically\./.test(row.lifecycleError ?? ""),
          verificationPaused: row.lifecycleError?.includes("Automatic verification is paused.") ?? false };
        const current = JSON.stringify(state);
        if (current !== previous) { observations.push({ ...state, observedAt: new Date().toISOString() }); previous = current; }
        return row;
      },
      accept: row => Date.now() < deadlineAt && row.id === worker.id && row.companyId === fixtures.company.id
        && row.lifecycleState === "ready" && !row.lifecycleError,
      reject: row => {
        if (row.id !== worker.id || row.companyId !== fixtures.company.id) return "Morgan runtime identity changed";
        if (["pending_approval", "paused", "rejected", "terminated", "terminating", "cleaning_up"].includes(row.lifecycleState)) return "Morgan runtime setup stopped";
        // Public agent rows omit lifecycleOperation. The lifecycle owner exposes its
        // automatic-recovery promise and manual-repair boundary in fixed diagnostics.
        const recovering = originalDeadline !== undefined && row.lifecycleState === "verifying"
          && /\b(?:Paperclip will|It will) retry automatically\./.test(row.lifecycleError ?? "")
          && !row.lifecycleError?.includes("Automatic verification is paused.");
        return row.lifecycleError && !recovering ? "Morgan runtime setup failed" : undefined;
      } });
  } finally {
    await ctx.input.evidence(`chat-catalog-worker-readiness-${worker.id}.json`, {
      policy: originalDeadline === undefined ? "authored-45s" : "original-native-case-clock",
      deadlineAt, agentId: worker.id, companyId: fixtures.company.id, observations,
    });
  }
  return worker;
}

export function retryDefinition(scenarioId: string, grade: ChatCatalogCase["grade"], initialOutcome: (observation: InternalObservation) => boolean): ChatCatalogCase {
  const definition = makeDefinition(scenarioId, async ctx => ({ retryQuery: ctx.scenario.query }), grade);
  return { ...definition, expectedRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 420_000,
    async act(ctx, state) {
      const first = await pollUntil({ label: "Initial creation before explicit user retry", deadlineAt: Date.now() + 150_000,
        load: () => observeInternal(ctx, state),
        accept: o => {
          const rows = scenarioId === "projects.create-project" ? o.projects.filter(row => row.name === "Launch") : o.goals;
          return rows.length === (scenarioId === "projects.create-project" ? 1 : 2) && initialOutcome(o) && ctx.issue()?.conversationState === "waiting"
            && o.runs.length === 1 && o.runs.every(row => row.status === "succeeded");
        },
      });
      state.firstCreation = { ...first, state: structuredClone(state) };
      state.firstIds = (scenarioId === "projects.create-project" ? first.projects.filter(row => row.name === "Launch") : first.goals).map(row => row.id);
      await ctx.input.evidence("chat-catalog-before-explicit-retry.json", { firstIds: state.firstIds, observation: first });
      const { sendChatMessage } = await import("../chat-flow.js");
      await sendChatMessage(ctx.input.page, ctx.scenario.query);
    },
  };
}
