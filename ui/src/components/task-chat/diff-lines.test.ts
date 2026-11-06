import { describe, expect, it } from "vitest";
import { parseUnifiedDiffLines } from "./diff-lines";

describe("parseUnifiedDiffLines", () => {
  it("skips file headers but keeps header-like changed lines inside a hunk", () => {
    const parsed = parseUnifiedDiffLines(
      "diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n keep\n",
    );
    expect(parsed).toMatchObject({ added: 1, removed: 1 });
    expect(parsed.lines).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "remove", text: "-- old comment" },
      { kind: "add", text: "++ new comment" },
      { kind: "context", text: "keep" },
    ]);
  });
});
