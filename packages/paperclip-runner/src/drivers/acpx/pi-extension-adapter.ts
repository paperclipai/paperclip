import { createHash } from "node:crypto";
import { redactPaperclipSemanticValue } from "../../semantic-tools/redaction.js";
import type { AcpxProfileExtensionAdapter, AcpxProfileExtensionContext } from "./profile-extensions.js";

export const PI_NOTICE_METHOD = "paperclip/pi_notice";
const CATEGORIES = new Set(["startup", "extension_notify", "invalid_question", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "summarization_retry_scheduled", "session_stats", "auto_compaction_policy", "runtime_failure"]);
const safeText = (value: string, limit = 4000) => String(redactPaperclipSemanticValue(value)).slice(0, limit);

/** Notices are display-only session evidence. They carry neither assistant
 * content nor authority to complete a turn, execute tools, or grant approval. */
export function createPiProfileExtensionAdapter(context: AcpxProfileExtensionContext): AcpxProfileExtensionAdapter {
  let sequence = 0;
  return {
    async request() { throw new Error("Pi has no qualified inbound extension request"); },
    async notification(method, params) {
      if (method !== PI_NOTICE_METHOD) return [];
      if (params.sessionId !== context.sessionId || typeof params.category !== "string" || !CATEGORIES.has(params.category)
        || typeof params.summary !== "string" || params.summary.length > 4000
        || !["info", "warning", "error"].includes(String(params.severity)) || Buffer.byteLength(JSON.stringify(params)) > 32 * 1024) {
        throw new Error("Pi native notice is outside its pinned contract");
      }
      const details = [{ name: "source.method", value: PI_NOTICE_METHOD }, { name: "source.nativeEvent", value: params.category },
        { name: "source.sessionId", value: safeText(context.sessionId) }];
      if (params.details && typeof params.details === "object" && !Array.isArray(params.details)) {
        const native = params.details as Record<string, unknown>;
        for (const key of ["attempt", "maxAttempts", "delayMs"]) if (Number.isSafeInteger(native[key]) && (native[key] as number) >= 0) details.push({ name: key, value: String(native[key]) });
        for (const key of ["success", "aborted", "willRetry", "enabled"]) if (typeof native[key] === "boolean") details.push({ name: key, value: String(native[key]) });
        for (const key of ["reason", "errorMessage"]) if (typeof native[key] === "string") details.push({ name: key, value: safeText(native[key] as string) });
      }
      const noticeId = `pi-notice-${createHash("sha256").update(JSON.stringify([context.sessionId, context.turnId, ++sequence])).digest("hex")}`;
      return [{ eventType: "provider.notice.recorded", itemId: noticeId, payload: {
        schema: "paperclip.provider.notice.v1", noticeId, severity: params.severity,
        category: `pi.${params.category}`, scope: "session", recoverable: params.severity !== "error", userActionable: false,
        summary: safeText(params.summary), details,
      } }];
    },
  };
}
