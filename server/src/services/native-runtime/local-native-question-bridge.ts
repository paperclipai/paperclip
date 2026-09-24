import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { HarnessRuntimeRequestResolution, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { flushNativeQuestionResponses, projectNativeRuntimeRequest, registerNativeQuestionCommandTarget } from "./native-question-bridge.js";
import { readPendingNativeRuntimeRequest } from "./runtime-request-resolution-authority.js";

/** The in-process executor must perform the same card projection and response
 * delivery as the durable PRP coordinator. The answer remains durable in DB. */
export function createLocalNativeQuestionBridge(input: {
  db: Db;
  binding: Parameters<typeof projectNativeRuntimeRequest>[0]["binding"];
  resolve: (input: {
    runId: string; requestId: string; turnId: string;
    resolution: HarnessRuntimeRequestResolution;
    authorizeBeforeDispatch: () => Promise<void>;
  }) => Promise<{ commandId: string }>;
}) {
  let release: (() => void) | undefined;
  const close = () => { release?.(); release = undefined; };
  return {
    close,
    async attach() {
      close();
      release = registerNativeQuestionCommandTarget({
        binding: input.binding,
        queueCommand: async (type, payload) => {
          if (type !== "request.resolve" || typeof payload?.requestId !== "string") throw new Error("native_question_command_invalid");
          const requestId = payload.requestId;
          const pending = await readPendingNativeRuntimeRequest(input.db, { ...input.binding, requestId });
          if (!pending || pending.requestKind !== "runtime") throw new Error("native_question_not_pending");
          const result = await input.resolve({
            runId: input.binding.runId, requestId, turnId: pending.turnId,
            resolution: { action: "submit", response: payload.response as never },
            authorizeBeforeDispatch: async () => {
              const current = await readPendingNativeRuntimeRequest(input.db, { ...input.binding, requestId });
              const [run] = await input.db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
                eq(heartbeatRuns.id, input.binding.runId), eq(heartbeatRuns.companyId, input.binding.companyId),
                eq(heartbeatRuns.nativeIssueId, input.binding.issueId), eq(heartbeatRuns.agentId, input.binding.agentId),
              )).limit(1);
              if (run?.status !== "running" || current?.turnId !== pending.turnId || current.requestKind !== "runtime") throw new Error("native_question_not_pending");
            },
          });
          return { commandId: result.commandId, controllerSeq: 0 };
        },
      });
      await flushNativeQuestionResponses(input.db, input.binding.runId);
    },
    async observe(event: PrpEvent) {
      const request = event.payload.request as Record<string, unknown> | undefined;
      if (event.eventType !== "runtime_request.created" || request?.type !== "input") return;
      await projectNativeRuntimeRequest({ db: input.db, binding: input.binding, event });
    },
  };
}
