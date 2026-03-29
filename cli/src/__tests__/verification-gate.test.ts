import { describe, expect, it } from "vitest";
import {
  evaluateRootGateSafety,
  parseTrackedStatusEntries,
} from "../../../scripts/verification-gate.mjs";

describe("verification gate preflight", () => {
  it("parses tracked git status entries and ignores untracked files", () => {
    const entries = parseTrackedStatusEntries([
      " M scripts/release.sh",
      "D  cli/package.json",
      "?? notes/tmp.txt",
    ].join("\n"));

    expect(entries).toEqual([
      { status: " M", path: "scripts/release.sh" },
      { status: "D ", path: "cli/package.json" },
    ]);
  });

  it("reports all root-gate blockers in one pass", () => {
    const existingPaths = new Set([
      "/repo/vitest.config.ts",
      "/repo/pnpm-workspace.yaml",
      "/repo/paperclip-orginal/packages/db/package.json",
      "/repo/paperclip-orginal/packages/shared/package.json",
      "/repo/paperclip-orginal/packages/adapter-utils/package.json",
      "/repo/paperclip-orginal/packages/adapters/codex-local/package.json",
      "/repo/paperclip-orginal/packages/adapters/cursor-local/package.json",
      "/repo/paperclip-orginal/packages/adapters/opencode-local/package.json",
    ]);

    const result = evaluateRootGateSafety({
      repoRoot: "/repo",
      gitStatusPorcelain: " M server/src/routes/authz.ts\n?? scratch.txt\n",
      fileExists: (candidatePath: string) => existingPaths.has(candidatePath),
      directoryExists: (candidatePath: string) => candidatePath === "/repo/paperclip-orginal",
    });

    expect(result.ok).toBe(false);
    expect(result.rootDirty).toBe(true);
    expect(result.problems.join("\n")).toContain("tracked git changes detected at root");
    expect(result.problems.join("\n")).toContain("required root files are missing");
    expect(result.problems.join("\n")).toContain("required workspace manifests are missing");
    expect(result.problems.join("\n")).toContain("legacy mirror workspace detected");
  });

  it("passes when root is clean and required files are present", () => {
    const existingPaths = new Set([
      "/repo/cli/package.json",
      "/repo/packages/adapter-utils/package.json",
      "/repo/pnpm-workspace.yaml",
      "/repo/vitest.config.ts",
      "/repo/packages/db/package.json",
      "/repo/packages/shared/package.json",
      "/repo/packages/adapters/codex-local/package.json",
      "/repo/packages/adapters/cursor-local/package.json",
      "/repo/packages/adapters/opencode-local/package.json",
    ]);

    const result = evaluateRootGateSafety({
      repoRoot: "/repo",
      gitStatusPorcelain: "",
      fileExists: (candidatePath: string) => existingPaths.has(candidatePath),
      directoryExists: () => false,
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });
});
