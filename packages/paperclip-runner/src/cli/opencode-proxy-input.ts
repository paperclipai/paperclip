export { enqueueSerialInput as enqueueOpenCodeProxyInput } from "./serial-input-queue.js";

import type { OpenCodeCompletionFeedback } from "../drivers/opencode/opencode-server-driver.js";

/** Preserve the exact call binding and the controller's acceptance/rejection. */
export function openCodeProxyCompletionFeedback(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): OpenCodeCompletionFeedback {
  return async (result, call) => {
    const response = await request("item/tool/call", { ...call, arguments: result });
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("Completion controller returned an invalid response");
    const value = response as Record<string, unknown>;
    const items = Array.isArray(value.contentItems) ? value.contentItems : [];
    const feedback = items.flatMap(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const entry = item as Record<string, unknown>;
      return entry.type === "inputText" && typeof entry.text === "string" ? [entry.text] : [];
    }).join("\n");
    if (value.success === false) throw new Error(feedback || "Completion report rejected by the controller");
    if (value.success !== true || !feedback.trim())
      throw new Error("Completion controller omitted accepted feedback");
    return feedback;
  };
}
