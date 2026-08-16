import { describe, expect, it } from "vitest";
import { extractWikiRelations, parseWikiProperties } from "../src/wiki/second-brain-model.js";

describe("second-brain Markdown model", () => {
  it("indexes aliases and normalized tags from frontmatter and the note body", () => {
    const parsed = parseWikiProperties(`---
aliases: [Launch plan, Go Live]
tags:
  - Strategy
  - delivery
private: false
priority: 3
---

# Release

This belongs to #delivery and #second-brain.
`);

    expect(parsed.aliases).toEqual(["Go Live", "Launch plan"]);
    expect(parsed.tags).toEqual(["delivery", "second-brain", "Strategy"]);
    expect(parsed.frontmatter).toMatchObject({ private: false, priority: 3 });
  });

  it("extracts wikilinks and local Markdown links while ignoring code and external URLs", () => {
    const relations = extractWikiRelations(`
See [[Roadmap|the roadmap]], [[Roadmap#Q4]], and [decisions](../decisions.md#approved).

Ignore [Paperclip](https://paperclip.ing) and \`[[inline-code]]\`.

\`\`\`
[[fenced-code]]
\`\`\`
`);

    expect(relations).toEqual([
      { target: "Roadmap", label: "the roadmap", relationType: "links_to" },
      { target: "../decisions.md", label: "decisions", relationType: "links_to" },
    ]);
  });
});
