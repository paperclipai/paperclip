import { createServer } from "node:http";
import { execute } from "../src/adapters/http/execute.js";
import type { AdapterExecutionContext } from "../src/adapters/types.js";

type RuntimeTarget = {
  id: "crewai" | "langgraph" | "custom-http";
  path: string;
  expectedFramework: string;
  runtimeProfile: "http+crewai" | "http+langgraph" | "custom-http";
  runtimeHeader?: string;
};

const targets: RuntimeTarget[] = [
  { id: "crewai", path: "/crewai", expectedFramework: "CrewAI", runtimeProfile: "http+crewai", runtimeHeader: "CrewAI" },
  { id: "langgraph", path: "/langgraph", expectedFramework: "LangGraph", runtimeProfile: "http+langgraph", runtimeHeader: "LangGraph" },
  { id: "custom-http", path: "/custom-http", expectedFramework: "CustomHTTP", runtimeProfile: "custom-http" },
];

function assertRuntimeBody(target: RuntimeTarget, payload: Record<string, unknown>) {
  const runtime =
    payload.runtime && typeof payload.runtime === "object"
      ? (payload.runtime as Record<string, unknown>)
      : null;
  if (!runtime) throw new Error(`${target.id}: missing runtime object`);
  if (runtime.framework !== target.expectedFramework) {
    throw new Error(`${target.id}: expected framework=${target.expectedFramework}, got=${String(runtime.framework)}`);
  }
}

async function main() {
  const logs: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const framework =
        req.url === "/crewai" ? "CrewAI" : req.url === "/langgraph" ? "LangGraph" : "CustomHTTP";
      logs.push(`[server] ${req.method} ${req.url} framework=${framework}`);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          framework,
          runtime: {
            framework,
            installed: true,
            version: "matrix-simulated",
          },
          echoBytes: body.length,
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine matrix server port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const baseCtx: Omit<AdapterExecutionContext, "config" | "context" | "runId"> = {
    agent: {
      id: "AGENT-42",
      companyId: "COMPANY-ALPHA",
      name: "phase1-runtime-matrix",
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
      logs.push(`[adapter:${stream}] ${chunk.trim()}`);
    },
  };

  const results: Array<{ id: RuntimeTarget["id"]; ok: boolean; reason: string }> = [];
  for (const target of targets) {
    try {
      const result = await execute({
        ...baseCtx,
        runId: `RUN-${target.id.toUpperCase()}`,
        config: {
          url: `${baseUrl}${target.path}`,
          method: "POST",
          runtimeProfile: target.runtimeProfile,
          ...(target.runtimeHeader ? { headers: { "x-agent-runtime": target.runtimeHeader } } : {}),
          payloadTemplate: { fixtureId: `MATRIX-${target.id}` },
        },
        context: {
          taskSpec: {
            contract_version: "v1alpha",
            task_id: `TASK-${target.id}`,
            goal_id: `GOAL-${target.id}`,
            company_id: "COMPANY-ALPHA",
            assignee_agent_id: "AGENT-42",
            title: `Runtime matrix ${target.id}`,
            instructions: "Return runtime identity response.",
            priority: "high",
            trace_context: { run_id: `RUN-${target.id}`, correlation_id: `CORR-${target.id}` },
          },
        },
      });
      const payload =
        result.resultJson && typeof result.resultJson === "object"
          ? (result.resultJson as Record<string, unknown>)
          : null;
      if (!payload) throw new Error("missing response json");
      assertRuntimeBody(target, payload);
      results.push({ id: target.id, ok: true, reason: "runtime contract pass" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({ id: target.id, ok: false, reason });
    }
  }

  server.close();

  const passed = results.filter((r) => r.ok).length;
  for (const result of results) {
    console.log(`${result.id}: ${result.ok ? "PASS" : "FAIL"} (${result.reason})`);
  }
  console.log(`TOTAL: ${passed}/${results.length} PASS`);
  console.log("LIVE_ADAPTER_LOGS_START");
  for (const line of logs) console.log(line);
  console.log("LIVE_ADAPTER_LOGS_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
