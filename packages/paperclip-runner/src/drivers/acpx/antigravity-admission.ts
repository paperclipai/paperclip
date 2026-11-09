import { createHash, randomBytes } from "node:crypto";
import { createAntigravityQuestionBridge } from "./antigravity-questions.js";

export const ANTIGRAVITY_ADMISSION_SCHEMA = "paperclip.antigravity.admission.v1";
const SESSION_METHODS = new Set(["session/new", "session/load", "session/resume"]);

export class AntigravityAdmissionError extends Error {
  readonly code = "ANTIGRAVITY_ADMISSION_FAILED";
  readonly retryable = false;
  constructor(detail: string) { super(`Antigravity admission failed: ${detail}`); this.name = "AntigravityAdmissionError"; }
}

export function antigravityInstructionBinding(content: string) {
  if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content) > 256 * 1024) {
    throw new AntigravityAdmissionError("instructions exceed their size limit or contain NUL");
  }
  return { digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`, byteLength: Buffer.byteLength(content) };
}

export function assertAntigravityPromptPolicy(content: string): void {
  // Native slash commands can alter account/configuration before inference.
  if (content.split(/\r\n|\r|\n/u).some(line => line.trimStart().startsWith("/"))) throw new AntigravityAdmissionError("native slash commands are unavailable in a managed task");
}

/** No saved ACPX record can substitute for this actual connection's receipt. */
export function createAntigravityAdmission(content: string, model: string) {
  const binding = antigravityInstructionBinding(content);
  if (typeof model !== "string" || !model.trim() || model.includes("\0") || model.length > 512) {
    throw new AntigravityAdmissionError("an explicit model is required");
  }
  let current: { sessionId: string | null; error: Error | null } | null = null;
  const assertReady = () => {
    if (current?.error) throw current.error;
    if (!current?.sessionId) throw new AntigravityAdmissionError("the native configuration receipt is missing");
  };
  return {
    assertReady,
    createGuard() {
      const state = { sessionId: null as string | null, error: null as Error | null };
      current = state;
      let initialized = false;
      const sessions = new Map<string, string>();
      let nativeSelection = new Map<string, string>();
      const pending = new Map<string | number, { method: string; nonce?: string; sessionId?: string }>();
      const questions = createAntigravityQuestionBridge(id => typeof id === "string" && sessions.has(id));
      const fail = (detail: string): never => { throw new AntigravityAdmissionError(detail); };
      return (direction: "inbound" | "outbound", value: unknown): void => {
        if (current !== state) throw new AntigravityAdmissionError("connection authority was replaced");
        if (state.error) throw state.error;
        const message = record(value);
        const params = record(message.params);
        const method = message.method;
        const id = message.id;
        try {
          if (direction === "outbound" && typeof method === "string") {
            const isSession = SESSION_METHODS.has(method);
            const isModel = method === "session/set_model" || method === "session/set_config_option";
            if (method.startsWith("session/") && !isSession) {
              if (typeof params.sessionId !== "string" || !sessions.has(params.sessionId)) fail("operation belongs to an unacknowledged session");
            }
            if (isSession || isModel) {
              if (!initialized) fail("the runtime does not advertise the required native admission patch");
              if (isModel && !(method === "session/set_model" ? params.modelId === model : params.configId === "model" && params.value === model)) {
                fail("only the exact selected model can be configured");
              }
              if (typeof id !== "string" && typeof id !== "number") fail("native admission requires a request identity");
              if ([...pending.values()].some(request => request.nonce)) fail("a native configuration request is already pending");
              const nonce = randomBytes(24).toString("hex");
              const meta = record(params._meta);
              params._meta = { ...meta, antigravity: {
                ...record(meta.antigravity), systemPrompt: { append: content },
                paperclipAdmission: { schema: ANTIGRAVITY_ADMISSION_SCHEMA, nonce, model, ...binding },
              } };
              message.params = params;
              state.sessionId = null;
              sessions.clear();
              nativeSelection.clear();
              questions.clear();
              if (pending.has(id as string | number) || pending.size >= 128) fail("duplicate or excessive native admission requests");
              pending.set(id as string | number, { method, nonce, ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}) });
            } else if (method === "session/prompt") {
              assertReady();
              if (params.sessionId !== state.sessionId || !Array.isArray(params.prompt)
                || params.prompt.some(value => record(value).type !== "text" || typeof record(value).text !== "string")) fail("prompt is outside the admitted text session");
              assertAntigravityPromptPolicy((params.prompt as unknown[]).map(value => record(value).text).join("\n"));
            } else if (!["initialize", "session/cancel", "session/close"].includes(method)) {
              fail("native control is unavailable in a managed task");
            }
            if (method === "initialize" && (typeof id === "string" || typeof id === "number")) {
              if (pending.has(id)) fail("duplicate initialize identity");
              pending.set(id, { method });
            }
            if (method === "session/close" && typeof params.sessionId === "string") {
              sessions.delete(params.sessionId); state.sessionId = null; nativeSelection.clear(); questions.clear();
            }
          }
          if (direction === "inbound" && method === undefined && (typeof id === "string" || typeof id === "number")) {
            const request = pending.get(id);
            if (request) {
              pending.delete(id);
              if (message.error !== undefined) return; // Keep the provider's typed error.
              const result = record(message.result);
              if (request.method === "initialize") {
                const info = record(result.agentInfo);
                const native = record(record(record(result.agentCapabilities)._meta).antigravity);
                if (info.name !== "antigravity-acp" || info.version !== "1.4.3" || native.paperclipAdmission !== 1) fail("runtime identity or native admission patch is unavailable");
                initialized = true;
              } else if (request.nonce) {
                const ack = record(record(result._meta).paperclipAntigravityAdmission);
                const sessionId = request.sessionId ?? result.sessionId;
                if (typeof sessionId !== "string" || !sessionId || ack.schema !== ANTIGRAVITY_ADMISSION_SCHEMA
                  || ack.nonce !== request.nonce || ack.sessionId !== sessionId || ack.model !== model
                  || ack.digest !== binding.digest || ack.byteLength !== binding.byteLength
                  || typeof ack.connectionId !== "string" || !ack.connectionId || ack.connectionId.length > 256) fail("native configuration receipt is missing, stale, or mismatched");
                const selected = selectedModel(result);
                if (selected !== undefined && selected !== model) fail("provider acknowledged a different model");
                const mode = record(result.modes).currentModeId;
                if (mode !== undefined && mode !== "default") fail("native permissions are outside the admitted default mode");
                nativeSelection = selectionValues(result);
                projectConcreteModel(result, model);
                sessions.set(sessionId as string, ack.connectionId as string);
                state.sessionId = sessionId as string;
              }
            }
          }
          if (direction === "inbound" && method === "session/update") {
            const update = record(params.update);
            if (update.sessionUpdate === "config_option_update" && sessions.has(String(params.sessionId))
              && selectedModel(update) !== undefined && selectedModel(update) !== model) fail("provider changed the admitted model");
            if (update.sessionUpdate === "config_option_update" && sessions.has(String(params.sessionId))) {
              for (const [id, value] of selectionValues(update)) {
                if (nativeSelection.get(id) !== value) fail("provider changed the admitted model, thinking level, or permission mode");
              }
              projectConcreteModel(update, model);
            }
            if (update.sessionUpdate === "current_mode_update" && update.currentModeId !== "default") fail("provider changed the admitted permission mode");
          }
          questions.guard(direction, message);
        } catch (error) {
          state.error = error instanceof AntigravityAdmissionError ? error : new AntigravityAdmissionError(error instanceof Error ? error.message : "invalid native protocol");
          state.sessionId = null; sessions.clear(); nativeSelection.clear(); pending.clear(); questions.clear();
          throw state.error;
        }
      };
    },
  };
}

function selectionValues(value: Record<string, unknown>): Map<string, string> {
  const selected = new Map<string, string>();
  if (!Array.isArray(value.configOptions)) return selected;
  for (const entry of value.configOptions) {
    const option = record(entry);
    if (!["model", "thinking_level", "mode"].includes(String(option.id))) continue;
    if (typeof option.currentValue !== "string" || selected.has(String(option.id))) {
      throw new AntigravityAdmissionError("invalid native selection state");
    }
    selected.set(String(option.id), option.currentValue);
  }
  return selected;
}

/** Native model options group variants into a family plus thinking level.
 * ACPX treats currentValue as a concrete model ID. Project only after the
 * native receipt binds the actual initialized variant; keep the native values
 * above so subsequent family/thinking changes cannot inherit that authority.
 */
function projectConcreteModel(value: Record<string, unknown>, model: string): void {
  if (!Array.isArray(value.configOptions)) return;
  for (const entry of value.configOptions) {
    const option = record(entry);
    if (option.id === "model") option.currentValue = model;
  }
}

function selectedModel(value: Record<string, unknown>): unknown {
  // The native model selector can group concrete variants under a display
  // family. The exact initialized model is bound by the native receipt;
  // only models.currentModelId is an additional concrete-model assertion.
  return record(value.models).currentModelId;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
