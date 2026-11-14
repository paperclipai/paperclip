import { describe, expect, it } from "vitest";
import { adapterUsesAiConnection } from "./ai-connections.js";

describe("adapterUsesAiConnection", () => {
  it.each(["paperclip_runner", "claude_local", "codex_local", "opencode_local", "hermes_local"])(
    "keeps the saved connection for %s",
    (adapterType) => {
      expect(adapterUsesAiConnection(adapterType)).toBe(true);
    },
  );

  it.each(["bob_shell", "kimi_local", "process"])(
    "does not carry a connection onto %s",
    (adapterType) => {
      expect(adapterUsesAiConnection(adapterType)).toBe(false);
    },
  );
});
