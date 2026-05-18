import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Shadow mode must be off for these tests
process.env.DONE_GATE_SHADOW_MODE = "false";

// Mock the logger to avoid file I/O in tests
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock node:child_process so execFileAsync in done-gate is controllable per test.
// vitest hoists vi.mock() calls, so this runs before the module is imported.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Stub the DB — done-gate only uses it for project workspace lookup
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  then: vi.fn().mockResolvedValue([]),
} as unknown as import("@paperclipai/db").Db;

// We need to control the DB query result; override the chain
function makeDbWithRepoUrl(repoUrl: string | null) {
  const row = repoUrl ? [{ repoUrl }] : [];
  return {
    select: () => ({
      from: () => ({
        where: () => ({ then: (fn: (r: typeof row) => unknown) => Promise.resolve(fn(row)) }),
      }),
    }),
  } as unknown as import("@paperclipai/db").Db;
}

import { execFile } from "node:child_process";
import { validateDoneGate } from "../services/done-gate.js";

// Helper: build a close comment body for Path A
function pathABody(
  opts: { url?: string; at?: string; sha?: string } = {},
) {
  const url = opts.url ?? "https://formationfx.vercel.app";
  const at = opts.at ?? new Date().toISOString();
  const sha = opts.sha ?? "a".repeat(40);
  return `verified_live_url: ${url}\nverified_at: ${at}\nverified_sha: ${sha}`;
}

// ---------------------------------------------------------------------------
// Path B tests (no external calls needed)
// ---------------------------------------------------------------------------

describe("done-gate Path B", () => {
  it("accepts non-shippable: audit", async () => {
    const result = await validateDoneGate({
      commentBody: "non-shippable: audit",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).toBeNull();
  });

  it("accepts non-shippable anywhere in body", async () => {
    const result = await validateDoneGate({
      commentBody: "## Done\n\nSome prose.\n\nnon-shippable: governance\n\nMore prose.",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).toBeNull();
  });

  it("accepts non-shippable with free-text qualifier", async () => {
    const result = await validateDoneGate({
      commentBody: "non-shippable: routine weekly sync",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).toBeNull();
  });

  it("accepts legal-action-carrier", async () => {
    const result = await validateDoneGate({
      commentBody: "non-shippable: legal-action-carrier",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).toBeNull();
  });

  it("accepts non-shippable case-insensitively", async () => {
    const result = await validateDoneGate({
      commentBody: "non-shippable: Audit",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).toBeNull();
  });

  it("rejects unknown non-shippable reason", async () => {
    const result = await validateDoneGate({
      commentBody: "non-shippable: random thing",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("path_b_reason_not_allowed");
  });
});

// ---------------------------------------------------------------------------
// Path C tests
// ---------------------------------------------------------------------------

describe("done-gate Path C", () => {
  it("rejects close-override with placeholder reason", async () => {
    const result = await validateDoneGate({
      commentBody: "close-override: some-approval-id",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("close_override_path_not_yet_enabled");
  });
});

// ---------------------------------------------------------------------------
// Missing close block
// ---------------------------------------------------------------------------

describe("done-gate missing block", () => {
  it("rejects when comment has no valid close block", async () => {
    const result = await validateDoneGate({
      commentBody: "Done! Fixed the bug.",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("missing_close_block");
  });

  it("rejects when comment is empty", async () => {
    const result = await validateDoneGate({
      commentBody: "",
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("missing_close_block");
  });

  it("rejects when comment is null", async () => {
    const result = await validateDoneGate({
      commentBody: null,
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("missing_close_block");
  });

  it("includes copy-pasteable example in rejection", async () => {
    const result = await validateDoneGate({
      commentBody: null,
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.example).toBeDefined();
    const ex = result?.example as Record<string, string>;
    expect(ex["Path A (shippable)"]).toContain("verified_live_url");
    expect(ex["Path B (non-shippable)"]).toContain("non-shippable");
  });
});

// ---------------------------------------------------------------------------
// Path A structural validation (no GitHub calls — SHA verification falls
// through to infra_unavailable when no repoUrl)
// ---------------------------------------------------------------------------

describe("done-gate Path A structural validation", () => {
  it("rejects when verified_live_url is missing https", async () => {
    const result = await validateDoneGate({
      commentBody: pathABody({ url: "http://not-secure.com" }),
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("path_a_invalid_live_url");
  });

  it("rejects missing verified_at", async () => {
    const result = await validateDoneGate({
      commentBody: "verified_live_url: https://example.com\nverified_sha: " + "a".repeat(40),
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("path_a_missing_verified_at");
  });

  it("rejects invalid verified_at", async () => {
    const result = await validateDoneGate({
      commentBody: pathABody({ at: "not-a-date" }),
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("path_a_invalid_verified_at");
  });

  it("rejects verified_at older than 60 min", async () => {
    const oldDate = new Date(Date.now() - 65 * 60 * 1000).toISOString();
    const result = await validateDoneGate({
      commentBody: pathABody({ at: oldDate }),
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("path_a_verified_at_too_old");
  });

  it("rejects missing verified_sha", async () => {
    const result = await validateDoneGate({
      commentBody: `verified_live_url: https://example.com\nverified_at: ${new Date().toISOString()}`,
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("path_a_missing_verified_sha");
  });

  it("rejects short sha", async () => {
    const result = await validateDoneGate({
      commentBody: pathABody({ sha: "abc123" }),
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("path_a_invalid_verified_sha_format");
  });

  it("rejects sha with uppercase hex", async () => {
    const result = await validateDoneGate({
      commentBody: pathABody({ sha: "A".repeat(40) }),
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result?.reason).toBe("path_a_invalid_verified_sha_format");
  });

  it("rejects when no project repoUrl (infra_unavailable → fail closed)", async () => {
    // No project → SHA verification can't proceed → infra_unavailable → reject
    const result = await validateDoneGate({
      commentBody: pathABody(),
      issueId: "issue-1",
      projectId: null,
      companyId: "co-1",
      db: makeDbWithRepoUrl(null),
    });
    expect(result?.reason).toBe("path_a_sha_infra_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Path A — SHA verification via GitHub API (mocked fetch)
// Use distinct SHAs per test to avoid hitting the module-level SHA cache.
// ---------------------------------------------------------------------------

const GITHUB_REPO_URL = "https://github.com/paperclipai/paperclip";

describe("done-gate Path A — SHA verification via GitHub API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("accepts Path A when GitHub API returns 200 (SHA exists on main)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));

    const result = await validateDoneGate({
      commentBody: pathABody({ sha: "b".repeat(40) }),
      issueId: "issue-sha-200",
      projectId: "proj-1",
      companyId: "co-1",
      db: makeDbWithRepoUrl(GITHUB_REPO_URL),
    });
    expect(result).toBeNull();
  });

  it("rejects with path_a_sha_not_found when GitHub API returns 404 (phantom SHA)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }));

    const result = await validateDoneGate({
      commentBody: pathABody({ sha: "c".repeat(40) }),
      issueId: "issue-sha-404",
      projectId: "proj-1",
      companyId: "co-1",
      db: makeDbWithRepoUrl(GITHUB_REPO_URL),
    });
    expect(result?.reason).toBe("path_a_sha_not_found");
    expect(result?.details).toMatchObject({ verifiedSha: expect.stringContaining("404") });
  });
});

// ---------------------------------------------------------------------------
// Path A — SHA verification fallback paths (fetch unavailable → ls-remote)
// ---------------------------------------------------------------------------

describe("done-gate Path A — ls-remote fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("accepts when GitHub API times out but ls-remote confirms SHA as main HEAD", async () => {
    const sha = "e".repeat(40);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network timeout")));
    // promisify(execFile) calls execFile(file, args, opts, callback); callback(err, value)
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      cb(null, { stdout: `${sha}\trefs/heads/main\n`, stderr: "" });
      return {} as any;
    });

    const result = await validateDoneGate({
      commentBody: pathABody({ sha }),
      issueId: "issue-sha-ls-ok",
      projectId: "proj-1",
      companyId: "co-1",
      db: makeDbWithRepoUrl(GITHUB_REPO_URL),
    });
    expect(result).toBeNull();
  });

  it("rejects with path_a_sha_infra_unavailable when both GitHub API and ls-remote fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network timeout")));
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      cb(new Error("git ls-remote failed"));
      return {} as any;
    });

    const result = await validateDoneGate({
      commentBody: pathABody({ sha: "d".repeat(40) }),
      issueId: "issue-sha-double-fail",
      projectId: "proj-1",
      companyId: "co-1",
      db: makeDbWithRepoUrl(GITHUB_REPO_URL),
    });
    expect(result?.reason).toBe("path_a_sha_infra_unavailable");
  });

  it("accepts via ls-remote directly for non-GitHub repo URLs when SHA matches main HEAD", async () => {
    const sha = "4".repeat(40);
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      cb(null, { stdout: `${sha}\trefs/heads/main\n`, stderr: "" });
      return {} as any;
    });

    const result = await validateDoneGate({
      commentBody: pathABody({ sha }),
      issueId: "issue-sha-non-gh-ok",
      projectId: "proj-1",
      companyId: "co-1",
      db: makeDbWithRepoUrl("https://gitea.example.com/org/repo"),
    });
    expect(result).toBeNull();
  });

  it("rejects with path_a_sha_infra_unavailable when ls-remote fails for non-GitHub repo", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      cb(new Error("git ls-remote: connection refused"));
      return {} as any;
    });

    const result = await validateDoneGate({
      commentBody: pathABody({ sha: "5".repeat(40) }),
      issueId: "issue-sha-non-gh-fail",
      projectId: "proj-1",
      companyId: "co-1",
      db: makeDbWithRepoUrl("https://gitea.example.com/org/repo"),
    });
    expect(result?.reason).toBe("path_a_sha_infra_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Shadow mode — behavioral tests
// DONE_GATE_SHADOW_MODE is a module-level constant evaluated at import time.
// Use vi.resetModules() + dynamic import to load a fresh module instance with
// the env var set to "true", then restore after each test.
// ---------------------------------------------------------------------------

describe("done-gate shadow mode (behavioral)", () => {
  afterEach(async () => {
    process.env.DONE_GATE_SHADOW_MODE = "false";
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function loadShadowGate() {
    process.env.DONE_GATE_SHADOW_MODE = "true";
    vi.resetModules();
    const mod = await import("../services/done-gate.js");
    expect(mod.DONE_GATE_SHADOW_MODE).toBe(true);
    return mod.validateDoneGate;
  }

  it("suppresses missing_close_block — returns null instead of 422", async () => {
    const shadowValidate = await loadShadowGate();
    const result = await shadowValidate({
      commentBody: "no valid close block here",
      issueId: "issue-shadow-1",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).toBeNull();
  });

  it("suppresses path_b_reason_not_allowed — returns null instead of 422", async () => {
    const shadowValidate = await loadShadowGate();
    const result = await shadowValidate({
      commentBody: "non-shippable: completely-random-not-in-allowlist",
      issueId: "issue-shadow-2",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).toBeNull();
  });

  it("suppresses path_a_sha_not_found — returns null instead of 422", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }));
    const shadowValidate = await loadShadowGate();
    const result = await shadowValidate({
      commentBody: pathABody({ sha: "0".repeat(40) }),
      issueId: "issue-shadow-3",
      projectId: "proj-1",
      companyId: "co-1",
      db: makeDbWithRepoUrl(GITHUB_REPO_URL),
    });
    expect(result).toBeNull();
  });

  it("suppresses path_a_sha_infra_unavailable — returns null instead of 422", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      cb(new Error("ls-remote failed"));
      return {} as any;
    });
    const shadowValidate = await loadShadowGate();
    const result = await shadowValidate({
      commentBody: pathABody({ sha: "1".repeat(40) }),
      issueId: "issue-shadow-4",
      projectId: "proj-1",
      companyId: "co-1",
      db: makeDbWithRepoUrl(GITHUB_REPO_URL),
    });
    expect(result).toBeNull();
  });

  it("suppresses close_override_path_not_yet_enabled — returns null instead of 422", async () => {
    const shadowValidate = await loadShadowGate();
    const result = await shadowValidate({
      commentBody: "close-override: approval-abc",
      issueId: "issue-shadow-5",
      projectId: null,
      companyId: "co-1",
      db: mockDb,
    });
    expect(result).toBeNull();
  });
});
