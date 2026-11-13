import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../services/attention.js";

// Card excerpts drop markdown syntax, not the characters people type inside
// words (PAP-767: "Scott archived this card ( 2)." on the classic page).
describe("attention card excerpts", () => {
  it("keeps #, - and _ inside words and numbers", () => {
    expect(stripMarkdown("Scott archived this card (#2).")).toBe("Scott archived this card (#2).");
    expect(stripMarkdown("Obligation: approval + in-review task")).toBe("Obligation: approval + in-review task");
    expect(stripMarkdown("newcomer@needs-you-demo.test")).toBe("newcomer@needs-you-demo.test");
    expect(stripMarkdown("use snake_case_name and 3 * 4 = 12")).toBe("use snake_case_name and 3 * 4 = 12");
  });

  it("still removes headings, quotes, bullets, rules, emphasis and code", () => {
    expect(stripMarkdown("## Plan\n- **Ship** the _new_ `thing`\n> quoted ~~old~~\n---\n* item two"))
      .toBe("Plan Ship the new thing quoted old item two");
    expect(stripMarkdown("See [the doc](https://example.test) ![shot](a.png)")).toBe("See the doc");
  });
});
