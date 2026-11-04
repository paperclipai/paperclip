import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseStdoutLine } = require("../../ui-parser.cjs") as {
  parseStdoutLine: (line: string, ts: string) => Array<{ kind: string; text?: string }>;
};

const TS = "2026-11-04T00:00:00.000Z";

describe("ui-parser.cjs parseStdoutLine — inline diff gutter", () => {
  it("classifies a gutter diff line as stdout, not assistant", () => {
    expect(parseStdoutLine("│ @@ -1,3 +1,4 @@", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "│ @@ -1,3 +1,4 @@" },
    ]);
  });

  it("classifies a colored gutter diff line as stdout", () => {
    expect(parseStdoutLine("\x1b[2m│\x1b[0m \x1b[32m+const x = 1;\x1b[0m", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "│ +const x = 1;" },
    ]);
  });

  it("keeps regular text as assistant", () => {
    expect(parseStdoutLine("Implemented the page.", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Implemented the page." },
    ]);
  });
});
