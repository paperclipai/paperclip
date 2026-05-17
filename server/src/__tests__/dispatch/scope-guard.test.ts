import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScopeGuardRuleSchema,
  parseRule,
  isKnownClass,
  KNOWN_SCOPE_GUARD_CLASSES,
} from "../../dispatch/scope-guard/taxonomy.js";
import { buildManifest, serializeManifest, parseManifest } from "../../dispatch/scope-guard/manifest.js";
import { renderHuman } from "../../dispatch/scope-guard/render.js";
import { writeWorktreeManifest } from "../../dispatch/scope-guard/write-worktree.js";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-guard-test-"));
  tempDirs.add(dir);
  return dir;
}

// ── Taxonomy schema tests ────────────────────────────────────────────────────

describe("taxonomy schema", () => {
  it("accepts all 13 known classes", () => {
    const validRules = [
      { class: "git.no_merge", tier: "hard" },
      { class: "git.no_push", tier: "hard" },
      { class: "git.no_force_push", tier: "hard" },
      { class: "git.protected_branch", tier: "hard", protectedBranches: ["main"] },
      { class: "git.no_remote_change", tier: "hard" },
      { class: "fs.no_touch_path", tier: "hard", paths: [".git/config"] },
      { class: "fs.repo_isolation", tier: "hard" },
      { class: "protocol.telegram_reply", tier: "post-hoc" },
      { class: "protocol.comment_format", tier: "post-hoc" },
      { class: "interaction.no_blocking_tools", tier: "advisory" },
      { class: "interaction.no_cross_company_comment", tier: "hard" },
      { class: "secrets.no_credential_read", tier: "hard" },
      { class: "time.budget_cap", tier: "post-hoc", heartbeats: 8 },
    ];

    expect(validRules).toHaveLength(KNOWN_SCOPE_GUARD_CLASSES.length);
    for (const rule of validRules) {
      expect(() => parseRule(rule), `Expected ${rule.class} to parse`).not.toThrow();
    }
  });

  it("rejects unknown classes at parse time", () => {
    const unknown = { class: "git.unknown_class", tier: "hard" };
    expect(() => parseRule(unknown)).toThrow();
  });

  it("rejects wrong tier for a class", () => {
    const wrongTier = { class: "git.no_push", tier: "advisory" };
    expect(() => parseRule(wrongTier)).toThrow();
  });

  it("isKnownClass returns true for all known classes", () => {
    for (const cls of KNOWN_SCOPE_GUARD_CLASSES) {
      expect(isKnownClass(cls)).toBe(true);
    }
  });

  it("isKnownClass returns false for unknown strings", () => {
    expect(isKnownClass("git.not_real")).toBe(false);
    expect(isKnownClass("")).toBe(false);
  });

  it("rejects git.protected_branch with empty protectedBranches", () => {
    const bad = { class: "git.protected_branch", tier: "hard", protectedBranches: [] };
    expect(() => parseRule(bad)).toThrow();
  });

  it("rejects fs.no_touch_path with empty paths", () => {
    const bad = { class: "fs.no_touch_path", tier: "hard", paths: [] };
    expect(() => parseRule(bad)).toThrow();
  });
});

// ── Manifest determinism tests ───────────────────────────────────────────────

describe("manifest determinism", () => {
  const FIXED_TIME = "2026-05-17T00:00:00.000Z";
  const input = {
    issueId: "c93a9af6-694c-4373-a65f-762a045f324c",
    generatedAt: FIXED_TIME,
    scopeGuard: {
      rules: [
        { class: "git.no_push", tier: "hard" },
        { class: "git.no_merge", tier: "hard", protectedBranches: ["main"] },
        { class: "time.budget_cap", tier: "post-hoc", heartbeats: 8 },
        { class: "interaction.no_blocking_tools", tier: "advisory", tools: ["submit_plan"] },
      ],
    },
  } as const;

  it("produces byte-identical output across 100 runs", () => {
    const first = serializeManifest(buildManifest(input));
    for (let i = 0; i < 99; i++) {
      const result = serializeManifest(buildManifest(input));
      expect(result).toBe(first);
    }
  });

  it("sorts rules by class name for deterministic ordering", () => {
    const manifest = buildManifest(input);
    const classes = manifest.rules.map((r) => r.class);
    const sorted = [...classes].sort();
    expect(classes).toEqual(sorted);
  });

  it("round-trips through JSON parse", () => {
    const manifest = buildManifest(input);
    const json = serializeManifest(manifest);
    const reparsed = parseManifest(JSON.parse(json));
    expect(serializeManifest(reparsed)).toBe(json);
  });
});

// ── Empty-input fallback tests ───────────────────────────────────────────────

describe("empty-input fallback", () => {
  it("returns empty rules array when scopeGuard is absent", () => {
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
    });
    expect(manifest.rules).toEqual([]);
  });

  it("returns empty rules when scopeGuard.rules is null-ish", () => {
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
      scopeGuard: { rules: undefined },
    });
    expect(manifest.rules).toEqual([]);
  });

  it("returns empty rules when scopeGuard.rules is empty", () => {
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
      scopeGuard: { rules: [] },
    });
    expect(manifest.rules).toEqual([]);
  });

  it("silently drops unknown classes rather than hard-erroring", () => {
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
      scopeGuard: {
        rules: [
          { class: "git.no_push", tier: "hard" },
          { class: "git.totally_unknown", tier: "hard" },
        ],
      },
    });
    expect(manifest.rules).toHaveLength(1);
    expect(manifest.rules[0]?.class).toBe("git.no_push");
  });
});

// ── Render snapshot tests ────────────────────────────────────────────────────

describe("render snapshot", () => {
  it("renders empty manifest with no-guards message", () => {
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
    });
    const output = renderHuman(manifest);
    expect(output).toMatchInlineSnapshot(`
      "## Scope guard

      _No scope guards active for this issue._
      "
    `);
  });

  it("renders full manifest grouped by tier", () => {
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
      scopeGuard: {
        rules: [
          { class: "git.no_push", tier: "hard" },
          { class: "git.no_merge", tier: "hard", protectedBranches: ["main"] },
          { class: "protocol.telegram_reply", tier: "post-hoc" },
          { class: "time.budget_cap", tier: "post-hoc", heartbeats: 8 },
          { class: "interaction.no_blocking_tools", tier: "advisory", tools: ["submit_plan", "question"] },
        ],
      },
    });
    const output = renderHuman(manifest);
    expect(output).toMatchInlineSnapshot(`
      "## Scope guard

      ### Hard-enforced

      - **Hard-enforced** — Do not merge (protected: main)
      - **Hard-enforced** — Do not push

      ### Post-hoc detected

      - **Post-hoc detected** — Replies must use the \`[telegram:reply]\` protocol
      - **Post-hoc detected** — Finish within 8 heartbeats

      ### Advisory

      - **Advisory** — Do not call blocking tools (submit_plan, question)

      _Manifest v1 · generated 2026-05-17T00:00:00.000Z_
      "
    `);
  });

  it("renders singular heartbeat without plural suffix", () => {
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
      scopeGuard: {
        rules: [{ class: "time.budget_cap", tier: "post-hoc", heartbeats: 1 }],
      },
    });
    const output = renderHuman(manifest);
    expect(output).toContain("within 1 heartbeat");
    expect(output).not.toContain("1 heartbeats");
  });
});

// ── Worktree write tests ─────────────────────────────────────────────────────

describe("writeWorktreeManifest", () => {
  it("writes scope-guard.json to $WORKTREE_ROOT/.paperclip/", () => {
    const root = makeTempDir();
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
      scopeGuard: {
        rules: [{ class: "git.no_push", tier: "hard" }],
      },
    });

    const result = writeWorktreeManifest(root, manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifestPath).toBe(path.join(root, ".paperclip", "scope-guard.json"));
    const raw = fs.readFileSync(result.manifestPath, "utf8");
    const parsed = parseManifest(JSON.parse(raw));
    expect(parsed.issueId).toBe("test-id");
    expect(parsed.rules).toHaveLength(1);
  });

  it("creates .paperclip dir if it does not exist", () => {
    const root = makeTempDir();
    const manifest = buildManifest({
      issueId: "test-id",
      generatedAt: "2026-05-17T00:00:00.000Z",
    });

    const result = writeWorktreeManifest(root, manifest);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(root, ".paperclip"))).toBe(true);
  });

  it("overwrites existing manifest on re-write", () => {
    const root = makeTempDir();
    const manifest1 = buildManifest({
      issueId: "id-v1",
      generatedAt: "2026-05-17T00:00:00.000Z",
    });
    const manifest2 = buildManifest({
      issueId: "id-v2",
      generatedAt: "2026-05-17T01:00:00.000Z",
    });

    writeWorktreeManifest(root, manifest1);
    // Make writable so overwrite succeeds in test environment
    fs.chmodSync(path.join(root, ".paperclip", "scope-guard.json"), 0o644);
    const result = writeWorktreeManifest(root, manifest2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = fs.readFileSync(result.manifestPath, "utf8");
    const parsed = parseManifest(JSON.parse(raw));
    expect(parsed.issueId).toBe("id-v2");
  });
});
