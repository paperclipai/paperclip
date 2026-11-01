import { it } from "vitest";

// Opt-in only: this uses the existing Codex login and makes a paid model call.
it.skipIf(process.env.PAPERCLIP_LIVE_TOOL_RESULTS !== "true")("delivers a large assigned result to live Codex through Runner", async () => {
  await import("../../__tests__/helpers/verify-assigned-tool-results-live.js");
}, 240_000);
