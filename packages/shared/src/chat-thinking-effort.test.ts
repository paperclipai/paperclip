import { describe, expect, it } from "vitest";
import {
  chatThinkingEffortAdapterConfigKey,
  chatThinkingEffortOptionsForAdapter,
  isChatThinkingEffortSupported,
} from "./chat-thinking-effort.js";

describe("chat thinking effort overrides", () => {
  it("keeps effort values constrained to each adapter's supported config key", () => {
    expect(chatThinkingEffortOptionsForAdapter("codex_local")).toContain("xhigh");
    expect(chatThinkingEffortOptionsForAdapter("codex_local")).toContain("ultra");
    expect(chatThinkingEffortAdapterConfigKey("codex_local")).toBe("modelReasoningEffort");

    expect(isChatThinkingEffortSupported("claude_local", "xhigh")).toBe(true);
    expect(isChatThinkingEffortSupported("claude_local", "ultra")).toBe(false);
    expect(chatThinkingEffortAdapterConfigKey("opencode_local")).toBe("variant");
    expect(isChatThinkingEffortSupported("unknown_adapter", "high")).toBe(false);
  });
});
