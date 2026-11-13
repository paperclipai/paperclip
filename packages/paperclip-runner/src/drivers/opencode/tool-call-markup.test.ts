import { describe, expect, it } from "vitest";
import { containsToolCallMarkup, visibleBeforeToolCallMarkup } from "./tool-call-markup.js";

// Recorded shape from chat-eval cohort 11 (DeepSeek v4.1 flash through OpenRouter).
const dsml = "<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"paperclip_paperclip_finish\">\n<｜DSML｜ parameter name=\"summary\" string=\"true\">Done.</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>";

describe("leaked tool-call markup", () => {
  it.each([
    ["recorded DSML block", `\n\n${dsml}`],
    ["DSML after prose", `Saved the file.\n${dsml}`],
    ["DSML inline after prose", `Saved the file.${dsml}`],
    ["ASCII-bar DSML", "<|DSML| invoke name=\"x\">"],
    ["DeepSeek native call tokens", "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function"],
    ["function_calls wrapper", "<function_calls>\n<invoke name=\"paperclip_finish\">\n</invoke>\n</function_calls>"],
    ["tool_call wrapper", "<tool_call>\n{\"name\": \"paperclip_finish\", \"arguments\": {}}\n</tool_call>"],
  ])("detects %s", (_label, text) => {
    expect(containsToolCallMarkup(text)).toBe(true);
  });

  it.each([
    ["plain prose", "Created the file and saved the plan."],
    ["prose naming a tag", "The model emits a <tool_call> tag when it wants a tool."],
    ["comparison operators", "Use x < 3 and y > 2."],
    ["HTML answer", "<div>\n<p>Hello</p>\n</div>"],
    ["wrapper without a call body", "<tool_call>\nis the tag Hermes models use.</tool_call>"],
    ["markup inside a code fence", `Here is the format:\n\`\`\`\n${dsml}\n<function_calls>\n<invoke name="x">\n\`\`\`\nThat is all.`],
  ])("ignores %s", (_label, text) => {
    expect(containsToolCallMarkup(text)).toBe(false);
  });

  it("holds a streaming fragment until it is decided, and only grows", () => {
    const answer = `Saved the file.\n\n${dsml}`;
    let shown = "";
    for (let end = 1; end <= answer.length; end += 1) {
      const visible = visibleBeforeToolCallMarkup(answer.slice(0, end));
      expect(visible.startsWith(shown)).toBe(true);
      shown = visible;
    }
    expect(shown).toBe("Saved the file.\n\n");
    expect(visibleBeforeToolCallMarkup("a < b")).toBe("a < b");
    expect(visibleBeforeToolCallMarkup("Done <")).toBe("Done ");
    expect(visibleBeforeToolCallMarkup("Done <b")).toBe("Done <b");
  });
});
