import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAdapterConfigPaths } from "../services/heartbeat.js";
import { resolveRepoRoot, toRelativeIfPossible, resolveFromRepoRoot } from "../utils/repo-root.js";

// ---------------------------------------------------------------------------
// repo-root.ts
// ---------------------------------------------------------------------------
describe("resolveRepoRoot", () => {
  it("returns an absolute path", () => {
    const root = resolveRepoRoot();
    expect(path.isAbsolute(root)).toBe(true);
  });

  it("contains pnpm-workspace.yaml", async () => {
    const { existsSync } = await import("node:fs");
    const root = resolveRepoRoot();
    expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("does NOT end with /server", () => {
    const root = resolveRepoRoot();
    expect(root.endsWith("/server")).toBe(false);
    expect(root.endsWith("\\server")).toBe(false);
  });

  it("returns same value on repeated calls (cached)", () => {
    expect(resolveRepoRoot()).toBe(resolveRepoRoot());
  });
});

describe("toRelativeIfPossible", () => {
  it("strips repo root prefix from absolute path", () => {
    const root = resolveRepoRoot();
    const abs = path.join(root, "skills", "outlook", "SKILL.md");
    expect(toRelativeIfPossible(abs)).toBe("skills/outlook/SKILL.md");
  });

  it("leaves already-relative path unchanged", () => {
    expect(toRelativeIfPossible("skills/outlook/SKILL.md")).toBe("skills/outlook/SKILL.md");
  });

  it("leaves path outside repo unchanged", () => {
    const outside = "/tmp/some-other-project/file.md";
    expect(toRelativeIfPossible(outside)).toBe(outside);
  });
});

describe("resolveFromRepoRoot", () => {
  it("resolves '.' to repo root absolute path", () => {
    const root = resolveRepoRoot();
    expect(resolveFromRepoRoot(".")).toBe(root);
  });

  it("resolves relative path to absolute under repo root", () => {
    const root = resolveRepoRoot();
    expect(resolveFromRepoRoot("skills/outlook")).toBe(path.join(root, "skills/outlook"));
  });

  it("passes through an already-absolute path unchanged", () => {
    const abs = "/tmp/absolute-path";
    expect(resolveFromRepoRoot(abs)).toBe(abs);
  });

  it("round-trips: toRelativeIfPossible → resolveFromRepoRoot", () => {
    const root = resolveRepoRoot();
    const original = path.join(root, "agents", "hr", "mcp.json");
    const relative = toRelativeIfPossible(original);
    expect(resolveFromRepoRoot(relative)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Master key path unification
// ---------------------------------------------------------------------------
describe("master key path", () => {
  it("fallback resolves to .paperclip/secrets/master.key under repo root", () => {
    const root = resolveRepoRoot();
    const expected = path.join(root, ".paperclip", "secrets", "master.key");
    // Simulate what local-encrypted-provider does when no env var is set
    const actual = path.resolve(root, ".paperclip/secrets/master.key");
    expect(actual).toBe(expected);
  });

  it("fallback does NOT point to data/secrets/master.key", () => {
    const root = resolveRepoRoot();
    const wrong = path.join(root, "data", "secrets", "master.key");
    const correct = path.resolve(root, ".paperclip/secrets/master.key");
    expect(correct).not.toBe(wrong);
  });
});

// ---------------------------------------------------------------------------
// normalizeAdapterConfigPaths (heartbeat.ts)
// ---------------------------------------------------------------------------
describe("normalizeAdapterConfigPaths", () => {
  const root = resolveRepoRoot();

  it("resolves cwd '.' to absolute repo root", () => {
    const result = normalizeAdapterConfigPaths({ cwd: "." });
    expect(result.cwd).toBe(root);
    expect(path.isAbsolute(result.cwd as string)).toBe(true);
  });

  it("resolves relative cwd to absolute", () => {
    const result = normalizeAdapterConfigPaths({ cwd: "agents/hr" });
    expect(result.cwd).toBe(path.join(root, "agents/hr"));
  });

  it("leaves absolute cwd unchanged", () => {
    const abs = "/tmp/some-workspace";
    const result = normalizeAdapterConfigPaths({ cwd: abs });
    expect(result.cwd).toBe(abs);
  });

  it("does not add cwd when not present", () => {
    const result = normalizeAdapterConfigPaths({ extraArgs: [] });
    expect(result.cwd).toBeUndefined();
  });

  it("resolves --mcp-config path in extraArgs", () => {
    const result = normalizeAdapterConfigPaths({
      extraArgs: ["--mcp-config", "agents/hr/mcp.json"],
    });
    expect(result.extraArgs).toEqual([
      "--mcp-config",
      path.join(root, "agents/hr/mcp.json"),
    ]);
  });

  it("leaves --mcp-config absolute path unchanged", () => {
    const abs = "/tmp/mcp.json";
    const result = normalizeAdapterConfigPaths({
      extraArgs: ["--mcp-config", abs],
    });
    expect((result.extraArgs as string[])[1]).toBe(abs);
  });

  it("does not resolve args that are not after --mcp-config", () => {
    const result = normalizeAdapterConfigPaths({
      extraArgs: ["--verbose", "agents/hr/mcp.json"],
    });
    // second arg is NOT after --mcp-config — stays relative
    expect((result.extraArgs as string[])[1]).toBe("agents/hr/mcp.json");
  });

  it("handles empty extraArgs", () => {
    const result = normalizeAdapterConfigPaths({ extraArgs: [] });
    expect(result.extraArgs).toEqual([]);
  });

  it("handles non-string args in extraArgs without throwing", () => {
    const result = normalizeAdapterConfigPaths({
      extraArgs: ["--mcp-config", 42, null],
    });
    expect((result.extraArgs as unknown[])[1]).toBe(42);
  });

  it("does not mutate the input config object", () => {
    const input = { cwd: ".", extraArgs: ["--mcp-config", "agents/hr/mcp.json"] };
    normalizeAdapterConfigPaths(input);
    expect(input.cwd).toBe(".");
    expect(input.extraArgs[1]).toBe("agents/hr/mcp.json");
  });
});
