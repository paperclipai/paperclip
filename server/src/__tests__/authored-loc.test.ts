/**
 * Unit tests for the authored-LOC exclusion set (BLO-9117).
 * One assertion per excluded pattern + a gitlink-only diff contributing 0,
 * plus the authored-vs-raw reduction.
 */
import { describe, expect, it } from "vitest";
import {
  AUTHORED_LOC_EXCLUSION_RULES,
  computeAuthoredLoc,
  isExcludedFromAuthoredLoc,
  matchExclusionRule,
  type GithubPullFile,
} from "../services/authored-loc.js";

function file(filename: string, extra: Partial<GithubPullFile> = {}): GithubPullFile {
  return { filename, additions: 10, deletions: 5, status: "modified", ...extra };
}

describe("authored-loc exclusion rules", () => {
  // One case per excluded pattern. Keyed by rule id so a renamed/removed rule
  // surfaces here rather than silently dropping coverage.
  const perPatternCases: Array<{ ruleId: string; file: GithubPullFile }> = [
    { ruleId: "generated_public_js", file: file("public/js/app.bundle.js") },
    { ruleId: "generated_public_js", file: file("server/public/js/vendor.js") },
    { ruleId: "generated_client_assets", file: file("public/client-js/assets/index-abc123.js") },
    { ruleId: "vendored", file: file("vendor/github.com/foo/bar/baz.go") },
    { ruleId: "wasm", file: file("packages/libmmt/mmt_fec.wasm") },
    { ruleId: "lockfile", file: file("pnpm-lock.yaml") },
    { ruleId: "lockfile", file: file("server/package-lock.json") },
    { ruleId: "lockfile", file: file("go.sum") },
    { ruleId: "lockfile", file: file("crates/x/Cargo.lock") },
    { ruleId: "lockfile", file: file("poetry.lock") },
    { ruleId: "swagger_codegen_go", file: file("internal/api/client_swaggergen.go") },
    { ruleId: "protobuf_go", file: file("proto/service.pb.go") },
    { ruleId: "protobuf_py", file: file("gen/service_pb2.py") },
  ];

  it("covers every declared rule with at least one positive case", () => {
    const declared = new Set(AUTHORED_LOC_EXCLUSION_RULES.map((r) => r.id));
    const tested = new Set(perPatternCases.map((c) => c.ruleId));
    // gitlink_only is exercised in its own test below.
    tested.add("gitlink_only");
    expect([...declared].sort()).toEqual([...tested].sort());
  });

  for (const { ruleId, file: f } of perPatternCases) {
    it(`excludes ${f.filename} via rule ${ruleId}`, () => {
      const rule = matchExclusionRule(f);
      expect(rule?.id).toBe(ruleId);
      expect(isExcludedFromAuthoredLoc(f)).toBe(true);
    });
  }

  it("does NOT exclude ordinary source files", () => {
    for (const name of [
      "server/src/services/authored-loc.ts",
      "mail/health.go", // not *_swaggergen.go / *.pb.go
      "src/components/Button.tsx",
      "scripts/deploy.py", // not *_pb2.py
      "vendored-feature/index.ts", // 'vendor' must be a path segment, not a prefix
    ]) {
      expect(isExcludedFromAuthoredLoc(file(name))).toBe(false);
    }
  });
});

describe("gitlink-only diffs", () => {
  it("contributes 0 authored-LOC and is classified as gitlink_only", () => {
    const gitlink: GithubPullFile = {
      filename: "pim/libmmt",
      additions: 0,
      deletions: 0,
      changes: 0,
      status: "modified",
      patch: "-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222",
    };
    expect(matchExclusionRule(gitlink)?.id).toBe("gitlink_only");
    const result = computeAuthoredLoc([gitlink]);
    expect(result.authoredLoc).toBe(0);
    expect(result.excludedPaths).toHaveLength(1);
    expect(result.excludedPaths[0]?.ruleId).toBe("gitlink_only");
  });

  it("treats a 0/0 file with no patch as gitlink-only", () => {
    expect(isExcludedFromAuthoredLoc({ filename: "vendor-sub", additions: 0, deletions: 0 })).toBe(true);
  });

  it("does NOT treat a real 0/0 rename as gitlink (it has a non-subproject patch)", () => {
    const renameWithContent: GithubPullFile = {
      filename: "src/new-name.ts",
      additions: 0,
      deletions: 0,
      status: "renamed",
      previous_filename: "src/old-name.ts",
      patch: "@@ -1 +1 @@\n some real content line",
    };
    // Not gitlink (patch has real content) and not otherwise excluded.
    expect(matchExclusionRule(renameWithContent)).toBeNull();
  });
});

describe("computeAuthoredLoc reduction", () => {
  it("separates authored from raw and keeps raw for comparison", () => {
    const files: GithubPullFile[] = [
      file("server/src/feature.ts", { additions: 100, deletions: 20 }), // authored
      file("public/js/app.bundle.js", { additions: 5000, deletions: 4000 }), // generated
      file("pnpm-lock.yaml", { additions: 800, deletions: 30 }), // lockfile
      file("proto/x.pb.go", { additions: 1200, deletions: 0 }), // codegen
    ];
    const r = computeAuthoredLoc(files);
    // Only the real source file counts as authored.
    expect(r.authoredAdditions).toBe(100);
    expect(r.authoredDeletions).toBe(20);
    expect(r.authoredLoc).toBe(120);
    // Raw retains everything for the contamination comparison.
    expect(r.rawLoc).toBe(100 + 20 + 5000 + 4000 + 800 + 30 + 1200);
    expect(r.excludedPaths.map((e) => e.ruleId).sort()).toEqual(
      ["generated_public_js", "lockfile", "protobuf_go"].sort(),
    );
  });

  it("is empty-safe", () => {
    const r = computeAuthoredLoc([]);
    expect(r.authoredLoc).toBe(0);
    expect(r.rawLoc).toBe(0);
    expect(r.excludedPaths).toEqual([]);
  });
});
