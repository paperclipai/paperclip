import type { HarnessRuntimeRequest, PaperclipQuestionSet } from "../../contracts/harness-driver.js";
import {
  CODEX_BLOCK_TOOL_NAME,
} from "../../contracts/codex.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import type { CodexRpcServerRequest } from "./app-server-transport.js";
import {
  boundedCodexValue,
  codexToolAcceptsDisposition as toolAcceptsDisposition,
  isCodexSemanticTool as isSemanticTool,
  isRetainableCodexPayload,
  redactCodexValue,
  rejectedCodexToolCall as rejectedToolCall,
} from "./codex-boundaries.js";
import {
  createCodexQuestionResponseContext,
  hasCodexQuestionForm,
  normalizeCodexQuestionSet,
  runtimeRequestKind,
  runtimeRequestPrompt,
  runtimeRequestProtocolPayload,
} from "./codex-question-adapter.js";
import { safeCodexRequestResponse as safeRequestResponse } from "./codex-thread-normalization.js";
import type { CodexSessionState } from "./codex-session-state.js";
import { admitResult } from "./codex-session-terminal.js";
import { boundedText, dynamicToolResponse, record, text } from "./codex-driver-values.js";

export async function handleServerRequest(
  state: CodexSessionState,
    request: CodexRpcServerRequest,
  ): Promise<Record<string, unknown>> {
    const sourceSequenceBefore = state.sourceSequence;
    let rejected = false;
    try {
      const response = await handleServerRequestBody(state, request);
      rejected = response.success === false;
      return response;
    } catch (error) {
      rejected = true;
      throw error;
    } finally {
      const correlation = request.paperclipTrace;
      if (correlation !== undefined) {
        const emittedEventIds: string[] = [];
        for (
          let sourceSeq = sourceSequenceBefore + 1;
          sourceSeq <= state.sourceSequence;
          sourceSeq += 1
        ) {
          emittedEventIds.push(
            `${state.runnerInstanceId}:${state.runId}:${sourceSeq}`,
          );
        }
        try {
          state.transport.recordTraceInterpretation?.({
            sourceEventId: correlation.sourceEventId,
            sourceEventType: correlation.sourceEventType,
            providerMethod: request.method,
            disposition: rejected
              ? "rejected"
              : emittedEventIds.length > 0
                ? "mapped"
                : "ignored",
            emittedEventIds,
            reason: rejected
              ? "Codex driver rejected the correlated provider server request"
              : emittedEventIds.length > 0
                ? "Codex driver mapped the correlated provider server request into canonical PRP events"
                : "Codex driver accepted the correlated provider server request without emitting a canonical PRP event",
          });
        } catch {
          // Trace delivery is deliberately outside run authority.
        }
      }
    }
  }

async function handleServerRequestBody(
  state: CodexSessionState,
    request: CodexRpcServerRequest,
  ): Promise<Record<string, unknown>> {
    if (request.method === "item/tool/call") {
      const tool = text(request.params.tool);
      const threadId = text(request.params.threadId);
      const turnId = text(request.params.turnId);
      const callId = text(request.params.callId);
      if (
        state.protocolFailed ||
        state.terminal ||
        threadId !== state.opened.threadId ||
        turnId.length === 0 ||
        turnId !== state.activeTurnId ||
        callId.length === 0
      ) {
        state.failProtocol(
          "tool_binding_mismatch",
          "Semantic tool call did not name the active thread and turn.",
        );
        return rejectedToolCall(
          "Semantic tool call was outside the active thread and turn.",
        );
      }
      if (!isSemanticTool(tool)) {
        const admitted = state.dynamicTools.some(
          (candidate) => candidate.name === tool,
        );
        if (admitted && state.dynamicToolHandler !== undefined) {
          state.emit(
            "item.started",
            {
              kind: "dynamicToolCall",
              item: {
                type: "tool_use",
                id: callId,
                name: tool,
                input: request.params.arguments,
              },
            },
            { turnId, itemId: callId },
          );
          try {
            const result = await state.dynamicToolHandler({
              tool,
              callId,
              threadId,
              turnId,
              arguments: request.params.arguments,
            });
            state.emit(
              "item.completed",
              {
                kind: "dynamicToolCall",
                item: {
                  type: "tool_result",
                  id: callId,
                  tool_use_id: callId,
                  result,
                },
              },
              { turnId, itemId: callId },
            );
            return dynamicToolResponse(result);
          } catch (error) {
            const message = boundedText(
              error instanceof Error ? error.message : error,
            );
            state.emit(
              "item.completed",
              {
                kind: "dynamicToolCall",
                item: {
                  type: "tool_result",
                  id: callId,
                  tool_use_id: callId,
                  error: message,
                  is_error: true,
                },
              },
              { turnId, itemId: callId },
            );
            return {
              success: false,
              contentItems: [{ type: "inputText", text: message }],
            };
          }
        }
        state.diagnoseUnsupported(`dynamic tool ${tool}`);
        return rejectedToolCall("Unsupported tool.");
      }
      if (!isRetainableCodexPayload(request.params.arguments)) {
        return rejectedToolCall(
          "Semantic result exceeded the retained payload limit.",
        );
      }
      const validation = validatePrpStructuredRunResult(
        request.params.arguments,
      );
      if (!validation.ok) {
        return {
          success: false,
          contentItems: [
            { type: "inputText", text: "Invalid semantic result." },
          ],
        };
      }
      if (
        !toolAcceptsDisposition(tool, validation.result.reportedWorkDisposition)
      ) {
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text:
                tool === CODEX_BLOCK_TOOL_NAME
                  ? "paperclip_block requires reportedWorkDisposition=blocked."
                  : "paperclip_finish accepts only done or needs_review.",
            },
          ],
        };
      }
      const admission = admitResult(state, validation.result, callId, turnId);
      if (admission === "conflict") {
        return rejectedToolCall(
          "A different semantic result was already committed.",
        );
      }
      return {
        success: true,
        contentItems: [
          { type: "inputText", text: "Semantic completion accepted." },
        ],
      };
    }

    const requestKind = runtimeRequestKind(request.method);
    if (requestKind === null) return safeRequestResponse(request.method);
    const requestTurnId = text(request.params.turnId);
    if (
      text(request.params.threadId) !== state.opened.threadId ||
      requestTurnId.length === 0 ||
      requestTurnId !== state.activeTurnId ||
      state.terminal ||
      state.protocolFailed
    ) {
      state.failProtocol(
        "runtime_request_binding_mismatch",
        "Runtime request did not name the active thread and turn.",
      );
      return safeRequestResponse(request.method);
    }
    const requestId = String(request.id);
    if (state.pendingRuntimeRequestMap.has(requestId)) {
      state.failProtocol(
        "runtime_request_duplicate",
        "Provider reused a pending runtime request identity.",
      );
      return safeRequestResponse(request.method);
    }
    let input: PaperclipQuestionSet | null = null;
    const responseContext = createCodexQuestionResponseContext();
    try {
      input = normalizeCodexQuestionSet(
        request.method,
        request.params,
        responseContext,
      );
    } catch {
      state.emit("harness.diagnostic", {
        code: "runtime_input_rejected",
        adapter: "codex-app-server",
        method: request.method,
        reason: "The provider input request contained an invalid question form.",
      }, { turnId: requestTurnId, itemId: String(request.id) });
      return safeRequestResponse(request.method);
    }
    if (
      (requestKind === "user_input" || requestKind === "elicitation") &&
      input === null &&
      hasCodexQuestionForm(request.method, request.params)
    ) {
      state.emit("harness.diagnostic", {
        code: "runtime_input_rejected",
        adapter: "codex-app-server",
        method: request.method,
        reason: "The provider input request did not contain a supported question form.",
      }, { turnId: requestTurnId, itemId: String(request.id) });
      return safeRequestResponse(request.method);
    }
    const runtimeRequest: HarnessRuntimeRequest = {
      requestId,
      requestKind,
      method: request.method,
      turnId: requestTurnId,
      itemId: text(request.params.itemId, requestId),
      status: "pending",
      prompt: runtimeRequestPrompt(requestKind, request.params),
      details: record(redactCodexValue(boundedCodexValue(request.params))),
      ...(input !== null ? { input } : {}),
      origin: {
        adapter: "codex-app-server",
        provider: "codex",
        method: request.method,
      },
    };
    state.emit(
      "runtime_request.created",
      {
        request: runtimeRequestProtocolPayload(runtimeRequest),
      },
      {
        turnId: requestTurnId,
        itemId: runtimeRequest.itemId,
      },
    );
    return new Promise<Record<string, unknown>>((settle) => {
      state.pendingRuntimeRequestMap.set(requestId, {
        request: runtimeRequest,
        responseContext,
        settle,
      });
    });
  }
