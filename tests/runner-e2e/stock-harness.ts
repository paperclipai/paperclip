import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerProfileFixture } from "./types.js";
import { readStockInstructionVariant } from "./stock-harness-instruction-variant.mjs";

// These are an independent product contract, not imports of the implementation
// constants. Otherwise a larger shipped manual could silently update the oracle.
export const STOCK_HIRE_IDENTITY = "You are an agent in a Paperclip company.\n";
export const STOCK_TEMPLATE_IDENTITY = "You are agent";
const SKILL_SOURCES = ["../../skills/paperclip/SKILL.md", "../../skills/paperclip/references/issue-documents.md"];
export function stockHarnessSkillSources() {
  return SKILL_SOURCES.map(source => {
    try {
      return { path: source.replace(/^\.\.\/\.\.\//, ""), present: true,
        sha256: createHash("sha256").update(readFileSync(new URL(source, import.meta.url))).digest("hex") };
    } catch (error) {
      if (source.endsWith("/references/issue-documents.md") && (error as NodeJS.ErrnoException).code === "ENOENT")
        return { path: source.replace(/^\.\.\/\.\.\//, ""), present: false, sha256: null };
      throw error;
    }
  });
}
const REMOVED_PROCEDURES = [
  "Execution contract:",
  "Start actionable work in this heartbeat",
  "clear final disposition",
  "After 2 consecutive failures of the same control-plane write",
  "Use child issues for parallel or long delegated work",
  "a successful process exit or final response is not sufficient",
];

export function productionDefaultHireProfile(profile: RunnerProfileFixture): RunnerProfileFixture {
  return {
    ...profile,
    buildAgent(input) {
      const { instructionsBundle: _fixtureManual, ...agent } = profile.buildAgent(input);
      return agent;
    },
  };
}

export interface StockHarnessEvidence {
  schema: "paperclip.stock-harness.v1";
  generation: "legacy" | "native";
  agentId: string;
  budgets: { companyMonthlyCents: unknown; agentMonthlyCents: unknown };
  bundle: { entryFile?: string; files: Array<{ path: string; content: string }> };
  invocations: Array<{ runId: string; prompt: unknown; promptMetrics?: Record<string, unknown>; conversationMode?: boolean }>;
  runIds: string[];
}

export function gradeStockHire(evidence: Pick<StockHarnessEvidence, "bundle" | "budgets">,
  instructionVariant = readStockInstructionVariant()) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  check("budget-hard-stops", evidence.budgets.companyMonthlyCents === 1_000 && evidence.budgets.agentMonthlyCents === 1_000,
    "Public company and agent records must both retain the 1,000-cent monthly hard stops.");
  check("default-hire-bundle", evidence.bundle.entryFile === "AGENTS.md" &&
    evidence.bundle.files.length === 1 && evidence.bundle.files[0]?.path === "AGENTS.md" &&
    evidence.bundle.files[0]?.content === instructionVariant.content,
  instructionVariant.variant === "reduced"
    ? "The public managed bundle must contain only the eight-word shipped identity, without an injected QA manual."
    : "The comparison bundle must exactly match the independently pinned historical manual; this is structural evidence, not a task outcome.");
  return checks;
}

export function gradeStockHarness(evidence: StockHarnessEvidence, instructionVariant = readStockInstructionVariant()) {
  const checks = gradeStockHire(evidence, instructionVariant);
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  check("provider-runs-present", evidence.runIds.length > 0 && evidence.runIds.every(Boolean),
    "The lifecycle oracle must reach actual provider runs; missing runs cannot pass instruction delivery.");
  if (evidence.generation === "legacy") {
    const prompts = evidence.invocations.filter(row => typeof row.prompt === "string" && row.prompt.length > 0);
    check("invocation-evidence-complete", evidence.runIds.length > 0 && evidence.runIds.every(runId =>
      prompts.some(row => row.runId === runId)),
    "Every legacy run must have a public adapter.invoke event with its actual nonempty prompt.");
    if (instructionVariant.variant === "reduced") {
      check("generic-procedures-absent", prompts.length > 0 && prompts.every(row =>
        REMOVED_PROCEDURES.every(procedure => !String(row.prompt).includes(procedure))),
      "Neither startup nor continuation may reintroduce the removed generic manual.");
    } else {
      const classified = prompts.every(row => typeof row.conversationMode === "boolean" &&
        typeof row.promptMetrics?.heartbeatPromptChars === "number" &&
        Number.isFinite(row.promptMetrics.heartbeatPromptChars) && row.promptMetrics.heartbeatPromptChars >= 0);
      const fresh = prompts.filter(row => Number(row.promptMetrics?.heartbeatPromptChars) > 0);
      const resumed = prompts.filter(row => row.promptMetrics?.heartbeatPromptChars === 0);
      check("historical-invocation-classification", prompts.length > 0 && classified,
        "Every invocation needs public run-scoped conversation mode and explicit template-delivery metrics.");
      check("historical-startup-contract", classified && fresh.length > 0 && fresh.every(row => row.conversationMode
        ? String(row.prompt).includes("Continue your Paperclip conversation using the supplied chat mode directive.") &&
          String(row.prompt).includes("After 2 consecutive failures of the same control-plane write")
        : String(row.prompt).includes("Execution contract:") && String(row.prompt).includes("Final disposition checklist:")),
      `Check each of ${fresh.length} fresh invocations against its historical task or conversation template.`);
      check("historical-continuation-contract", classified && resumed.every(row =>
        String(row.prompt).includes("## Paperclip Resume Delta") && (row.conversationMode
          ? !String(row.prompt).includes("Execution contract:")
          : String(row.prompt).includes("Execution contract: take concrete action") &&
            String(row.prompt).includes("a successful process exit or final response is not sufficient"))),
      `Check all ${resumed.length} observed continuation invocations separately; zero observations do not claim live continuation coverage.`);
    }
    const fresh = prompts.filter(row => Number(row.promptMetrics?.heartbeatPromptChars) > 0);
    check("fresh-default-delivered", fresh.length > 0 && fresh.every(row =>
      String(row.prompt).includes(STOCK_TEMPLATE_IDENTITY) && String(row.prompt).includes("Connection tools:") &&
      String(row.prompt).includes("connections_search")),
    "At least one fresh invocation must carry default identity and connection guidance.");
  }
  return checks;
}

/** Public API receipts only; no provider-memory claim or private runner hook. */
export async function captureStockHarness(input: {
  api: { get<T>(path: string): Promise<T> };
  agentId: string;
  companyId: string;
  generation: "legacy" | "native";
  runIds: string[];
}): Promise<StockHarnessEvidence> {
  const bundle = await input.api.get<{ entryFile: string; files: Array<{ path: string }> }>(
    `/api/agents/${input.agentId}/instructions-bundle`,
  );
  const [company, agent] = await Promise.all([
    input.api.get<{ budgetMonthlyCents: unknown }>(`/api/companies/${input.companyId}`),
    input.api.get<{ budgetMonthlyCents: unknown }>(`/api/agents/${input.agentId}`),
  ]);
  const files = await Promise.all(bundle.files.map(async file => {
    const detail = await input.api.get<{ content: string }>(
      `/api/agents/${input.agentId}/instructions-bundle/file?path=${encodeURIComponent(file.path)}`,
    );
    return { path: file.path, content: detail.content };
  }));
  const events = await Promise.all(input.runIds.map(async runId => ({
    runId,
    run: await input.api.get<{ id: string; companyId: string; agentId: string; contextSnapshot?: { conversationMode?: boolean } }>(
      `/api/heartbeat-runs/${runId}`,
    ),
    rows: await input.api.get<Array<{ eventType?: string; payload?: Record<string, unknown> }>>(
      `/api/heartbeat-runs/${runId}/events?limit=1000`,
    ),
  })));
  if (events.some(({ runId, run }) => run.id !== runId || run.companyId !== input.companyId || run.agentId !== input.agentId ||
      !run.contextSnapshot || typeof run.contextSnapshot !== "object" || Array.isArray(run.contextSnapshot) ||
      (run.contextSnapshot.conversationMode !== undefined && typeof run.contextSnapshot.conversationMode !== "boolean"))) {
    throw new Error("Stock invocation mode receipt is missing or bound to a different run/company/agent.");
  }
  return {
    schema: "paperclip.stock-harness.v1", generation: input.generation,
    budgets: { companyMonthlyCents: company.budgetMonthlyCents, agentMonthlyCents: agent.budgetMonthlyCents },
    agentId: input.agentId, bundle: { entryFile: bundle.entryFile, files }, runIds: input.runIds,
    invocations: events.flatMap(({ runId, rows, run }) => rows.filter(row => row.eventType === "adapter.invoke")
      .map(row => ({ runId, prompt: row.payload?.prompt, promptMetrics: row.payload?.promptMetrics as Record<string, unknown> | undefined,
        conversationMode: run.contextSnapshot?.conversationMode === true }))),
  };
}

export function stockHarnessSourceDigest() {
  const hash = createHash("sha256");
  for (const source of [
    "stock-harness.ts", "context-integrity-cases.ts", "context-integrity-scoring.ts",
    "context-integrity-flow.ts", "chat-cases.ts", "chat-flow.ts", "live-fixtures.ts", "runner.spec.ts",
    "stock-harness-checks.mjs", "stock-harness-admission.ts", "stock-harness-manifest.ts",
    "stock-harness-instruction-variant.mjs", "stock-harness-instruction-variant.d.mts", "stock-harness-instruction-variant.test.mjs",
    "fixtures/stock-harness/historical-default-agents.md", "automatic-retry.ts", "automatic-retry.test.ts", "types.ts", "catalog.ts", "launch.ts",
    "../../packages/adapter-utils/src/acpx-engine/execute.ts",
    "../../packages/adapter-utils/src/acpx-engine/ephemeral-session-environment.ts",
    "../../packages/adapter-utils/src/acpx-engine/ephemeral-session-environment.test.ts",
    "../../packages/paperclip-runner/scripts/generate-capability-contract.mjs",
    "../../packages/paperclip-runner/scripts/check-capability-inventory.mjs",
    "../../packages/paperclip-runner/scripts/lib/capability-inventory.mjs",
    "../../packages/paperclip-runner/spec/capability/source-contract.json",
    "../../packages/paperclip-runner/spec/capability/capabilities.yaml",
    "../../packages/paperclip-runner/spec/capability/eval-traceability.yaml",
    "../../packages/paperclip-runner/spec/capability/mcp-tool-map.yaml",
    "../../packages/paperclip-runner/spec/capability/inventory.schema.json",
    "../../packages/paperclip-runner/src/generated/capability-contract.ts",
    "../../packages/paperclip-runner/docs/capability-contract.md",
    ...["capabilities.yaml", "mcp-tool-map.yaml", "eval-traceability.yaml", "capability-contract.md", "downstream-handoff.md"]
      .map(file => `../../packages/paperclip-runner/generated/capability/${file}`),
    "../../server/src/onboarding-assets/default/AGENTS.md",
    "../../packages/adapter-utils/src/server-utils.ts",
    "../../packages/shared/src/connection-intent-guidance.ts",
  ]) hash.update(source).update(readFileSync(new URL(source, import.meta.url)));
  hash.update(JSON.stringify(stockHarnessSkillSources()));
  return hash.digest("hex");
}
