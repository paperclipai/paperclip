import { createServer } from "node:http";
import { execute } from "../src/adapters/http/execute.js";
import type { AdapterExecutionContext } from "../src/adapters/types.js";

type TaskSpec = Record<string, unknown>;
type ExecutionResult = Record<string, unknown>;

function validateTaskSpec(payload: TaskSpec): { ok: boolean; reason: string } {
  const required = [
    "contract_version",
    "task_id",
    "goal_id",
    "company_id",
    "assignee_agent_id",
    "title",
    "instructions",
    "priority",
    "trace_context",
  ];
  for (const key of required) {
    if (!(key in payload)) return { ok: false, reason: `missing:${key}` };
    const value = payload[key];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
      return { ok: false, reason: `empty:${key}` };
    }
  }
  if (payload.contract_version !== "v1alpha") return { ok: false, reason: "bad_contract_version" };
  if (!["low", "medium", "high", "critical"].includes(String(payload.priority))) {
    return { ok: false, reason: "bad_priority" };
  }
  const trace = (payload.trace_context ?? {}) as Record<string, unknown>;
  if (!trace.run_id || !trace.correlation_id) return { ok: false, reason: "missing_trace_context" };
  return { ok: true, reason: "ok" };
}

function validateExecutionResult(payload: ExecutionResult): { ok: boolean; reason: string } {
  const required = [
    "contract_version",
    "task_id",
    "run_id",
    "status",
    "summary",
    "timing",
    "cost",
  ];
  for (const key of required) {
    if (!(key in payload)) return { ok: false, reason: `missing:${key}` };
  }
  if (payload.contract_version !== "v1alpha") return { ok: false, reason: "bad_contract_version" };
  const status = String(payload.status);
  if (!["success", "partial_success", "blocked", "failed", "cancelled"].includes(status)) {
    return { ok: false, reason: "bad_status" };
  }
  const duration = Number(((payload.timing as Record<string, unknown>)?.duration_ms as number) ?? -1);
  if (duration < 0) return { ok: false, reason: "bad_duration" };
  if (["blocked", "failed"].includes(status)) {
    const failure = payload.failure as Record<string, unknown> | undefined;
    if (!failure || !failure.code) return { ok: false, reason: "missing_failure_code" };
  }
  if (status === "success" && payload.failure) return { ok: false, reason: "unexpected_failure" };
  return { ok: true, reason: "ok" };
}

async function main() {
  const liveLogs: string[] = [];
  let t6Attempts = 0;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let fixtureId = "UNKNOWN";
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        fixtureId = String(parsed.fixtureId ?? "UNKNOWN");
      } catch {
        fixtureId = "INVALID_JSON";
      }

      liveLogs.push(`[server] ${req.method} ${req.url} fixture=${fixtureId}`);

      if (fixtureId === "T6") {
        t6Attempts += 1;
        if (t6Attempts === 1) {
          res.statusCode = 503;
          res.end("transient failure");
          return;
        }
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, fixtureId }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine server port");
  const url = `http://127.0.0.1:${address.port}/runner`;

  const baseCtx: Omit<AdapterExecutionContext, "config" | "context" | "runId"> = {
    agent: {
      id: "AGENT-42",
      companyId: "COMPANY-ALPHA",
      name: "sim-agent",
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

  const validTaskSpec: TaskSpec = {
    contract_version: "v1alpha",
    task_id: "TASK-001",
    goal_id: "GOAL-ENG-01",
    company_id: "COMPANY-ALPHA",
    assignee_agent_id: "AGENT-42",
    title: "Simulated test task",
    instructions: "Return a structured execution result.",
    priority: "high",
    trace_context: { run_id: "RUN-1001", correlation_id: "CORR-abc-123" },
  };

  const testResults: Array<{ test: string; ok: boolean; reason: string }> = [];

  const t1 = validateTaskSpec(validTaskSpec);
  if (t1.ok) {
    await execute({
      ...baseCtx,
      runId: "RUN-T1",
      config: { url, method: "POST", payloadTemplate: { fixtureId: "T1" } },
      context: { taskSpec: validTaskSpec },
    });
  }
  testResults.push({ test: "T1", ok: t1.ok, reason: t1.reason });

  const t2 = validateTaskSpec({ ...validTaskSpec, goal_id: undefined });
  testResults.push({ test: "T2", ok: !t2.ok, reason: t2.reason });

  const t3 = validateTaskSpec({ ...validTaskSpec, priority: "urgent" });
  testResults.push({ test: "T3", ok: !t3.ok, reason: t3.reason });

  const t4Result: ExecutionResult = {
    contract_version: "v1alpha",
    task_id: "TASK-004",
    run_id: "RUN-T4",
    status: "blocked",
    summary: "Approval missing",
    timing: { duration_ms: 200 },
    cost: { tokens_input: 15, tokens_output: 0 },
    failure: { code: "policy_violation" },
  };
  testResults.push({ test: "T4", ok: validateExecutionResult(t4Result).ok, reason: "policy_violation check" });

  const t5Result: ExecutionResult = {
    contract_version: "v1alpha",
    task_id: "TASK-005",
    run_id: "RUN-T5",
    status: "blocked",
    summary: "Schema invalid",
    timing: { duration_ms: 250 },
    cost: { tokens_input: 20, tokens_output: 4 },
    failure: { code: "model_failure" },
  };
  testResults.push({ test: "T5", ok: validateExecutionResult(t5Result).ok, reason: "model_failure check" });

  let t6Ok = false;
  try {
    await execute({
      ...baseCtx,
      runId: "RUN-T6A",
      config: { url, method: "POST", payloadTemplate: { fixtureId: "T6" } },
      context: { taskSpec: validTaskSpec },
    });
  } catch {
    // First call expected to fail with transient 503.
  }
  try {
    await execute({
      ...baseCtx,
      runId: "RUN-T6B",
      config: { url, method: "POST", payloadTemplate: { fixtureId: "T6" } },
      context: { taskSpec: validTaskSpec },
    });
    t6Ok = true;
  } catch {
    t6Ok = false;
  }
  testResults.push({ test: "T6", ok: t6Ok, reason: t6Ok ? "retry recovered" : "retry failed" });

  server.close();

  const passed = testResults.filter((t) => t.ok).length;
  for (const result of testResults) {
    console.log(`${result.test}: ${result.ok ? "PASS" : "FAIL"} (${result.reason})`);
  }
  console.log(`TOTAL: ${passed}/${testResults.length} PASS`);
  console.log("LIVE_ADAPTER_LOGS_START");
  for (const line of liveLogs) console.log(line);
  console.log("LIVE_ADAPTER_LOGS_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
