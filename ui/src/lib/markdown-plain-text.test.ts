import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "./markdown-plain-text";

describe("markdownToPlainText", () => {
  it("flattens the creative-brief summary from the onboarding walk", () => {
    expect(markdownToPlainText(
      "The `creative-brief` document is saved on this task. It covers:\n\n- **Brand voice and audience:** Gen Z core buyers\n- **10 trend themes, plus 1 seasonal,** each with a lifespan rating",
    )).toBe("The creative-brief document is saved on this task. It covers: Brand voice and audience: Gen Z core buyers 10 trend themes, plus 1 seasonal, each with a lifespan rating");
  });

  it("keeps link and image text but drops their targets", () => {
    expect(markdownToPlainText("Open [the plan](#document-plan) and ![logo sketch](/files/logo.png)."))
      .toBe("Open the plan and logo sketch.");
  });

  it("drops headings, quotes, numbered lists, task boxes and code fences", () => {
    expect(markdownToPlainText("## Next steps\n> Note\n1. First\n2) Second\n- [x] Done\n```ts\nconst a = 1;\n```"))
      .toBe("Next steps Note First Second Done const a = 1;");
  });

  it("strips emphasis without touching snake_case, arithmetic, or lone markers", () => {
    expect(markdownToPlainText("Set __max_retries__ in my_config_file, *not* 2 * 3 or _this_. ~~old~~"))
      .toBe("Set max_retries in my_config_file, not 2 * 3 or this. old");
  });

  it("keeps autolinked URLs and email addresses", () => {
    expect(markdownToPlainText("Review <https://example.com/brief_v2> before approving, or ask <team@example.com>. <b>Bold</b>"))
      .toBe("Review https://example.com/brief_v2 before approving, or ask team@example.com. Bold");
  });

  it("keeps code verbatim, including dunder identifiers and markers inside fences", () => {
    expect(markdownToPlainText("Edit `__init__` and `*args`.\n\n```py\ndef f(__x__):\n    return **kw\n```\nDone."))
      .toBe("Edit __init__ and *args. def f(__x__): return **kw Done.");
  });

  it("returns plain text unchanged", () => {
    expect(markdownToPlainText("Approve the saved plan for a printable menu?"))
      .toBe("Approve the saved plan for a printable menu?");
  });
});
