import { execute } from "../src/adapters/http/execute.js";
import type { AdapterExecutionContext } from "../src/adapters/types.js";

function assertRuntimeContract(payload: Record<string, unknown>) {
  const runtime =
    payload.runtime && typeof payload.runtime === "object"
      ? (payload.runtime as Record<string, unknown>)
      : null;
  if (!runtime) throw new Error("CrewAI smoke failed: response.runtime missing");
  if (runtime.framework !== "CrewAI") {
    throw new Error(`CrewAI smoke failed: runtime.framework expected CrewAI, got ${String(runtime.framework)}`);
  }
  if (runtime.installed !== true) {
    throw new Error(`CrewAI smoke failed: runtime.installed expected true, got ${String(runtime.installed)}`);
  }
  if (typeof runtime.version !== "string" || runtime.version.trim().length === 0) {
    throw new Error("CrewAI smoke failed: runtime.version missing or empty");
  }
}

async function main() {
  const webhookUrl = process.env.CREWAI_WEBHOOK_URL ?? "http://127.0.0.1:8000/webhook";
  const liveLogs: string[] = [];

  let healthOk = false;
  try {
    const parsed = new URL(webhookUrl);
    const healthUrl = `${parsed.protocol}//${parsed.host}/health`;
    const res = await fetch(healthUrl);
    healthOk = res.ok;
    liveLogs.push(`[preflight] health ${healthUrl} status=${res.status}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    liveLogs.push(`[preflight] health check skipped/error=${msg}`);
  }

  const validTaskSpec = {
    contract_version: "v1alpha",
    task_id: "TASK-CREWAI-001",
    goal_id: "GOAL-CREWAI-BRIDGE",
    company_id: "COMPANY-ALPHA",
    assignee_agent_id: "AGENT-42",
    title: "CrewAI webhook smoke",
    instructions: "Acknowledge Paperclip webhook payload.",
    priority: "high",
    trace_context: { run_id: "RUN-CREWAI-1001", correlation_id: "CORR-crewai-bridge" },
  };

  const baseCtx: Omit<AdapterExecutionContext, "config" | "context" | "runId"> = {
    agent: {
      id: "AGENT-42",
      companyId: "COMPANY-ALPHA",
      name: "phase1-crewai-smoke",
      adapterType: "http",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    onLog: async (stream, chunk) => {
      liveLogs.push(`[adapter:${stream}] ${chunk.trim()}`);
    },
  };

  const result = await execute({
    ...baseCtx,
    runId: "RUN-CREWAI-SMOKE",
    config: { url: webhookUrl, method: "POST", payloadTemplate: { fixtureId: "CREWAI_PHASE1_SMOKE" } },
    context: { taskSpec: validTaskSpec },
  });

  const responsePayload =
    result.resultJson && typeof result.resultJson === "object"
      ? (result.resultJson as Record<string, unknown>)
      : null;
  if (!responsePayload) {
    throw new Error("CrewAI smoke failed: HTTP adapter response JSON missing");
  }
  assertRuntimeContract(responsePayload);

  console.log(`CREWAI_WEBHOOK_URL=${webhookUrl}`);
  console.log(`HEALTH=${healthOk ? "PASS" : "SOFT-BLOCK"}`);
  console.log("TOTAL: 1/1 PASS");
  console.log("LIVE_ADAPTER_LOGS_START");
  for (const line of liveLogs) console.log(line);
  console.log("LIVE_ADAPTER_LOGS_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
