import { describe, expect, it } from "vitest";
import { buildGrokAccessPrompt, buildGrokRoutinePrompt } from "./grok-bot-setup-prompt";
describe("Grok Bot onboarding instructions", () => {
  it("keeps pairing and routine credentials out of chat instructions", () => {
    const access = buildGrokAccessPrompt("https://paperclip.example/mcp/runner", "Night Shift");
    expect(access).toContain("paperclip_grok_inbox");
    expect(access).toContain("enter the one-use pairing code there");
    expect(access).not.toContain("paperclip_dot_");
    const routine = buildGrokRoutinePrompt("11111111-1111-4111-8111-111111111111", "Night Shift");
    expect(routine).toContain("paperclip_grok_ack_wake");
    expect(routine).toContain("bindingGeneration");
    expect(routine).toContain("paperclip_grok_request_turn");
    expect(routine).not.toContain("paperclip_dot_");
    expect(routine).not.toContain("Bearer ");
  });
});
