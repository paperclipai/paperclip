import { describe, expect, it } from "vitest";
import { claudeNativeSkillPrompt } from "./native-skill-prompt.js";

const envelope = (description: unknown, prompt = "Write the welcome note now.") => JSON.stringify({
  schema: "paperclip.native-model-envelope.v2",
  task: { description, prompt },
  interactionResponses: [{ response: { status: "accepted" } }],
});

describe("Claude native task skill invocation", () => {
  it.each(["Use the `first-task` skill (/first-task).", "$first-task"])("invokes %s before the unchanged current request", (description) => {
    const text = envelope(description);
    expect(claudeNativeSkillPrompt(text, ["first-task", "paperclip"])).toBe(`/first-task ${text}`);
  });
  it.each([
    envelope("Ordinary task", "Please mention /first-task in the output."),
    envelope("/not-assigned"), envelope(null), envelope("/first-task-extra"),
    JSON.stringify({ schema: "another-envelope", task: { description: "/first-task" } }),
    "Use /first-task", "null", "[]",
  ])("does not invoke from unrelated or malformed input: %s", (text) => {
    expect(claudeNativeSkillPrompt(text, ["first-task"])).toBe(text);
  });
  it("does not invent an assignment or pick between multiple requested skills", () => {
    const text = envelope("/first-task and /research");
    expect(claudeNativeSkillPrompt(text, [])).toBe(text);
    expect(claudeNativeSkillPrompt(text, ["first-task", "research"])).toBe(text);
  });
});
