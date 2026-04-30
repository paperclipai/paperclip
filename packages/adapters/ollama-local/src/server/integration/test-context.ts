import type {
  AdapterAgent,
  AdapterExecutionContext,
  AdapterInvocationMeta,
  AdapterRuntime,
} from "@paperclipai/adapter-utils";

export interface LogEvent {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface CapturedContext {
  ctx: AdapterExecutionContext;
  logs: LogEvent[];
  stdout(): string;
  stderr(): string;
  meta: AdapterInvocationMeta[];
}

/**
 * Build an AdapterExecutionContext suitable for exercising the ollama-local
 * adapter. Callers supply the runtime config and any scenario overrides.
 */
export function buildContext(params: {
  config: Record<string, unknown>;
  runContext?: Record<string, unknown>;
  runId?: string;
  agent?: Partial<AdapterAgent>;
  authToken?: string;
}): CapturedContext {
  const agent: AdapterAgent = {
    id: params.agent?.id ?? "agent-test",
    companyId: params.agent?.companyId ?? "company-test",
    name: params.agent?.name ?? "Test Agent",
    adapterType: params.agent?.adapterType ?? "ollama_local",
    adapterConfig: params.agent?.adapterConfig ?? null,
  };
  const runtime: AdapterRuntime = {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
  };
  const logs: LogEvent[] = [];
  const meta: AdapterInvocationMeta[] = [];

  const ctx: AdapterExecutionContext = {
    runId: params.runId ?? "run-test",
    agent,
    runtime,
    config: params.config,
    context: params.runContext ?? {},
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    onMeta: async (invocation) => {
      meta.push(invocation);
    },
    authToken: params.authToken,
  };

  return {
    ctx,
    logs,
    stdout: () => logs.filter((e) => e.stream === "stdout").map((e) => e.chunk).join(""),
    stderr: () => logs.filter((e) => e.stream === "stderr").map((e) => e.chunk).join(""),
    meta,
  };
}

/**
 * Minimal happy-path NDJSON frame sequence. Produces a 3-piece assistant
 * message plus a final frame with usage + a reported prompt_eval_count.
 */
export function happyPathFrames(opts: {
  pieces?: string[];
  model?: string;
  promptEvalCount?: number;
  evalCount?: number;
  doneReason?: string;
} = {}): unknown[] {
  const pieces = opts.pieces ?? ["Hello, ", "Paperclip ", "team."];
  const model = opts.model ?? "llama3.1:8b";
  const frames: unknown[] = pieces.map((content) => ({
    model,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content },
    done: false,
  }));
  frames.push({
    model,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: opts.doneReason ?? "stop",
    total_duration: 5_000_000,
    load_duration: 1_000_000,
    prompt_eval_count: opts.promptEvalCount ?? 128,
    prompt_eval_duration: 100_000,
    eval_count: opts.evalCount ?? 24,
    eval_duration: 900_000,
  });
  return frames;
}
