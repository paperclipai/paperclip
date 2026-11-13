import { describe, expect, it } from "vitest";
import { containsToolCallMarkup, visibleBeforeToolCallMarkup } from "./tool-call-markup.js";

const dsml = "<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"paperclip_paperclip_finish\">\n<｜DSML｜ parameter name=\"summary\" string=\"true\">Done.</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>";
const markupForms = {
  "recorded DSML block": dsml,
  "ASCII-bar DSML": "<|DSML| invoke name=\"x\">",
  "DeepSeek call tokens": "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function",
  "ASCII call tokens": "<|tool_calls_begin|><|tool_call_begin|>function",
  "function_calls wrapper": "<function_calls>\n<invoke name=\"paperclip_finish\">\n</invoke>\n</function_calls>",
  "tool_call wrapper": "<tool_call>\n{\"name\": \"paperclip_finish\", \"arguments\": {}}\n</tool_call>",
};

describe("leaked tool-call markup", () => {
  it.each(Object.entries(markupForms))("detects %s alone and after prose", (_label, markup) => {
    expect(containsToolCallMarkup(`\n\n${markup}`)).toBe(true);
    expect(containsToolCallMarkup(`Saved the file.\n${markup}`)).toBe(true);
  });

  it("detects a sentinel inline after prose", () => {
    expect(containsToolCallMarkup(`Saved the file.${dsml}`)).toBe(true);
  });

  it.each([
    ["plain prose", "Created the file and saved the plan."],
    ["prose naming a tag", "The model emits a <tool_call> tag when it wants a tool."],
    ["comparison operators", "Use x < 3 and y > 2."],
    ["HTML answer", "<div>\n<p>Hello</p>\n</div>"],
    ["wrapper without a call body", "<tool_call>\nis the tag Hermes models use.</tool_call>"],
    ["markup in a backtick fence", `Here is the format:\n\`\`\`\n${dsml}\n<function_calls>\n<invoke name="x">\n\`\`\`\nThat is all.`],
    ["markup in a tilde fence", `~~~text\n${dsml}\n~~~`],
    ["shorter fence lines inside a longer fence", `\`\`\`\`markdown\n\`\`\`\n${dsml}\n\`\`\`\n\`\`\`\``],
    ["other fence characters inside a fence", `~~~\n\`\`\`\n${dsml}\n~~~`],
    ["an indented fence line inside a top-level fence", `\`\`\`\n    \`\`\`\n${dsml}\n\`\`\``],
    ["a list-indented fence", `10. Example:\n\n    \`\`\`\n    ${dsml}\n    \`\`\``],
  ])("ignores %s", (_label, text) => {
    expect(containsToolCallMarkup(text)).toBe(false);
  });

  it("detects markup after a closed fence", () => {
    expect(containsToolCallMarkup(`\`\`\`\`\nexample\n\`\`\`\`\n${dsml}`)).toBe(true);
  });

  it.each(Object.entries(markupForms))("streams %s without showing any of it, at every split point", (_label, markup) => {
    const answer = `Saved the file. Done <\n\n${markup}`;
    let shown = "";
    for (let end = 1; end <= answer.length; end += 1) {
      const visible = visibleBeforeToolCallMarkup(answer.slice(0, end));
      expect(visible.startsWith(shown)).toBe(true);
      shown = visible;
    }
    expect(shown).toBe("Saved the file. Done <\n\n");
  });

  it("releases a held fragment once it cannot become markup", () => {
    expect(visibleBeforeToolCallMarkup("a < b")).toBe("a < b");
    expect(visibleBeforeToolCallMarkup("Done <")).toBe("Done ");
    expect(visibleBeforeToolCallMarkup("Done <|tool_call")).toBe("Done ");
    expect(visibleBeforeToolCallMarkup("Done <|tool_call>")).toBe("Done <|tool_call>");
    expect(visibleBeforeToolCallMarkup("Done <b")).toBe("Done <b");
  });
});
