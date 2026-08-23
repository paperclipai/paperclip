import { describe, expect, it } from "vitest";
import {
  extractCitations,
  summarizeCitationVerdicts,
  verifyCitations,
} from "./citation-verification.js";

/** Minimal fake tree; keys are repo-relative paths. */
function tree(files: Record<string, string>) {
  return {
    readFileLines: async (p: string) => (p in files ? files[p].split("\n") : null),
  };
}

describe("extractCitations", () => {
  it("pulls a plain path:line and the symbol it claims to show", () => {
    const c = extractCitations("see `extractPaperclipDisposition` at packages/a/src/parse.ts:12");
    expect(c).toHaveLength(1);
    expect(c[0]?.path).toBe("packages/a/src/parse.ts");
    expect(c[0]?.lines).toEqual([12]);
    expect(c[0]?.claimedSymbols).toContain("extractPaperclipDisposition");
  });

  it("handles the multi-line form an audit table produces", () => {
    const c = extractCitations("`parse.ts:2,174,184` imports/calls `extractPaperclipDisposition`");
    expect(c[0]?.lines).toEqual([2, 174, 184]);
  });

  it("ignores prose that merely looks path-like", () => {
    expect(extractCitations("version 1.2:3 of the spec")).toHaveLength(0);
    expect(extractCitations("no citations here at all")).toHaveLength(0);
  });
});

describe("verifyCitations", () => {
  const files = {
    "packages/a/src/parse.ts": [
      "import { extractPaperclipDisposition } from '@paperclipai/adapter-utils';", // 1
      "const x = 1;",                                                              // 2
      "const y = 2;",                                                              // 3
      "  const { disposition } = extractPaperclipDisposition(raw);",               // 4
    ].join("\n"),
    "packages/b/src/execute.ts": [
      "const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;",
    ].join("\n"),
  };

  it("verifies a citation whose line really shows the claimed symbol", async () => {
    const v = await verifyCitations(
      extractCitations("`extractPaperclipDisposition` — packages/a/src/parse.ts:4"), tree(files));
    expect(v[0]?.status).toBe("verified");
  });

  // THE CASE THAT MOTIVATED THIS MODULE.
  it("rejects a citation whose line EXISTS but does not show the claimed symbol", async () => {
    const v = await verifyCitations(
      extractCitations("routes via `createAcpxEngineExecutor` — packages/b/src/execute.ts:3"), tree(files));
    expect(v[0]?.status).toBe("refuted");
    if (v[0]?.status === "refuted") {
      expect(v[0].reason).toContain("shows none of them");
    }
  });

  it("rejects a citation to a file that does not exist", async () => {
    const v = await verifyCitations(
      extractCitations("`thing` — packages/nope/src/gone.ts:3"), tree(files));
    expect(v[0]).toMatchObject({ status: "refuted", reason: "file_not_found" });
  });

  it("rejects a line past the end of the file", async () => {
    const v = await verifyCitations(
      extractCitations("`thing` — packages/b/src/execute.ts:900"), tree(files));
    if (v[0]?.status === "refuted") expect(v[0].reason).toContain("line_out_of_range");
    else throw new Error("expected refuted");
  });

  it("does not silently pass a citation with nothing to check", async () => {
    const v = await verifyCitations(extractCitations("packages/b/src/execute.ts:2"), tree(files));
    expect(v[0]).toMatchObject({ status: "unchecked", reason: "no_claimed_symbol_on_this_line" });
  });

  it("tolerates a citation a few lines off rather than nitpicking", async () => {
    // line 1 holds the import; citing 3 is close enough to be honest evidence.
    const v = await verifyCitations(
      extractCitations("`extractPaperclipDisposition` — packages/a/src/parse.ts:3"), tree(files));
    expect(v[0]?.status).toBe("verified");
  });

  it("checks every line of a multi-line citation independently", async () => {
    const v = await verifyCitations(
      extractCitations("`extractPaperclipDisposition` — packages/a/src/parse.ts:1,4,900"), tree(files));
    expect(v.map((x) => x.status)).toEqual(["verified", "verified", "refuted"]);
  });
});

describe("summarizeCitationVerdicts", () => {
  it("counts and names the failures", async () => {
    const files = { "a.ts": "export const realSymbol = 1;" };
    const v = await verifyCitations(
      extractCitations("`realSymbol` a.ts:1 and `other` missing/b.ts:5"), tree(files));
    const s = summarizeCitationVerdicts(v);
    expect(s.total).toBe(2);
    expect(s.refuted).toBe(1);
    expect(s.refutations[0]).toContain("missing/b.ts:5");
  });
});

describe("the real fabricated audit row (TSMC-21344, 2026-08-23)", () => {
  // Verbatim shape from the audit that motivated this module. Kept hermetic so
  // it regression-protects the behaviour without depending on the live repo.
  const ROW =
    "| gemini-local | yes (via shared ACP engine, no adapter-owned copy) |"
    + " `packages/adapters/gemini-local/src/server/execute.ts:269` -> `createAcpxEngineExecutor`;"
    + " engine itself imports the extractor at `packages/adapter-utils/src/acpx-engine/execute.ts:2` |";

  const files = {
    // Line 269 EXISTS but is unrelated — this is why existence checks are not enough.
    "packages/adapters/gemini-local/src/server/execute.ts":
      Array.from({ length: 300 }, (_, i) => (i === 268 ? "    (typeof context.issueId === \"string\"" : "// x")).join("\n"),
    // The engine really does import the extractor on line 2.
    "packages/adapter-utils/src/acpx-engine/execute.ts":
      "import x from 'y';\nimport { extractPaperclipDisposition } from '../disposition-marker.js';\n",
  };

  it("refutes the invented citation whose line exists but shows something else", async () => {
    const verdicts = await verifyCitations(extractCitations(ROW), tree(files));
    const s = summarizeCitationVerdicts(verdicts);
    expect(s.refuted).toBe(1);
    expect(s.refutations[0]).toContain("gemini-local/src/server/execute.ts:269");
  });

  it("does NOT refute the honest citation on the same row", async () => {
    const verdicts = await verifyCitations(extractCitations(ROW), tree(files));
    const acpx = verdicts.find((v) => v.citation.path.includes("acpx-engine"));
    // Its claim sits too far away to attribute, so it is unchecked — never refuted.
    expect(acpx?.status).not.toBe("refuted");
  });
});

describe("untrusted paths", () => {
  it("a traversal path simply fails to resolve rather than reading outside the tree", async () => {
    // The heartbeat's reader refuses to escape the workspace root and returns
    // null; the verifier must treat that as a refutation, not a crash.
    const deps = { readFileLines: async (p: string) => (p.includes("..") ? null : ["ok"]) };
    const v = await verifyCitations(extractCitations("`secret` ../../../etc/passwd.ts:1"), deps);
    expect(v[0]).toMatchObject({ status: "refuted", reason: "file_not_found" });
  });
});
