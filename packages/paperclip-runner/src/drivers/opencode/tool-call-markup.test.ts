import { describe, expect, it } from "vitest";
import { containsToolCallMarkup, controlTokenStart, visibleBeforeModelScaffolding, visibleBeforeToolCallMarkup } from "./tool-call-markup.js";

const dsml = "<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"paperclip_paperclip_finish\">\n<｜DSML｜ parameter name=\"summary\" string=\"true\">Done.</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>";
const markupForms = {
  "recorded DSML block": dsml,
  "ASCII-bar DSML": "<|DSML| invoke name=\"x\">",
  "DeepSeek call tokens": "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function",
  "ASCII call tokens": "<|tool_calls_begin|><|tool_call_begin|>function",
  "function_calls wrapper": "<function_calls>\n<invoke name=\"paperclip_finish\">\n</invoke>\n</function_calls>",
  "tool_call wrapper": "<tool_call>\n{\"name\": \"paperclip_finish\", \"arguments\": {}}\n</tool_call>",
  // Recorded from chat-eval cohort 16 (task-coordination.block-on-design): after
  // a real paperclip_finish call, DeepSeek streamed only closing tags as text.
  "closing DSML tags only": "\r\n</｜DSML｜ invoke>\n</｜DSML｜ calls>\r\n</｜DSML｜ invoke>\n</｜DSML｜ calls>\r\n</invoke>\r\n</｜DSML｜ parameter>\n</invoke>\r\n</parameter>",
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
    ["a sentinel in inline code", "DeepSeek opens a call with `<｜DSML｜ invoke>` and closes it with `</｜DSML｜ invoke>`."],
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
    expect(shown.trimEnd()).toBe("Saved the file. Done <");
  });

  it("releases a held fragment once it cannot become markup", () => {
    expect(visibleBeforeToolCallMarkup("a < b")).toBe("a < b");
    expect(visibleBeforeToolCallMarkup("Done <")).toBe("Done ");
    expect(visibleBeforeToolCallMarkup("Done <|tool_call")).toBe("Done ");
    expect(visibleBeforeToolCallMarkup("Done <|tool_call>")).toBe("Done <|tool_call>");
    expect(visibleBeforeToolCallMarkup("Done <b")).toBe("Done <b");
  });
});

// Recorded from chat-eval cohort 16 (cases.case-history): the whole reply.
const degenerateReply = "<｜begin▁of▁sentence｜><?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<output>\nSearch output truncated. Let me search more specifically for \"case document\" and \"case events\".\n</output>";

describe("model control tokens", () => {
  it.each([
    ["the recorded degenerate reply", degenerateReply, 0],
    ["a ChatML turn after an answer", "The fact changed twice.\n<|im_start|>user\nthanks", 24],
    ["a token after an escaped backtick", "Use \\`code. <|im_end|> then `x`.", 12],
    ["a token after an unmatched backtick", "One ` tick. <|eot_id|>", 12],
    ["a trailing end-of-sentence token", "Riley changed it.<｜end▁of▁sentence｜>", 17],
    ["a Llama end-of-turn token", "Done.<|eot_id|>", 5],
  ])("finds %s", (_label, text, start) => {
    expect(controlTokenStart(text)).toBe(start);
  });

  it.each([
    ["an XML answer", "The export is XML:\n<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<case id=\"COM-C1\">\n  <fact name=\"diagnosis\">overlay</fact>\n</case>"],
    ["an answer about an <output> tag", "The tool wraps results in an <output> element, and </output> closes it."],
    ["an answer explaining chat templates in inline code", "ChatML starts a turn with `<|im_start|>` and ends it with `<|im_end|>`."],
    ["a double-backtick code span", "Write ``<|im_start|>`` with two backticks, then `x`."],
    ["a code span across lines", "The template opens with `<|im_start|>\nuser<|im_end|>` and so on."],
    ["a code span after a fence holding a lone backtick", "~~~text\n`\n~~~\nUse ``<|im_start|>`` here."],
    ["control tokens in a fence", "The template looks like this:\n```\n<|im_start|>user\nhi<|im_end|>\n```"],
    ["HTML", "<div>\n<p>Hello</p>\n</div>"],
    ["comparison operators", "Use x < 3 and y > 2."],
  ])("leaves %s alone", (_label, text) => {
    expect(controlTokenStart(text)).toBe(-1);
    expect(visibleBeforeModelScaffolding(text)).toBe(text);
  });

  it("never streams any of the recorded degenerate reply, at every split point", () => {
    for (let end = 1; end <= degenerateReply.length; end += 1)
      expect(visibleBeforeModelScaffolding(degenerateReply.slice(0, end))).toBe("");
  });

  it("streams prose up to a trailing token without showing the token", () => {
    const answer = "Riley changed it.<｜end▁of▁sentence｜>";
    let shown = "";
    for (let end = 1; end <= answer.length; end += 1) {
      const visible = visibleBeforeModelScaffolding(answer.slice(0, end));
      expect(visible.startsWith(shown)).toBe(true);
      shown = visible;
    }
    expect(shown).toBe("Riley changed it.");
  });
});
