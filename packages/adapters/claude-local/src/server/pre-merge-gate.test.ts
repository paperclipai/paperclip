import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluatePreMergeGates,
  fetchActiveAgentRuns,
  fetchLastCommentBody,
  fetchTicketForPr,
  parseGhPrMergeCommand,
  type PaperclipRunSnapshot,
  type PaperclipTicketSnapshot,
} from "./pre-merge-gate.js";
import {
  HOOK_RELATIVE_PATH,
  buildPreMergeHookScript,
} from "./pre-merge-gate-script.js";

const ctoTicket: PaperclipTicketSnapshot = {
  identifier: "MGC-2369",
  status: "in_review",
  assigneeAgentId: "cto",
  blocked: false,
};

const noActiveRuns: PaperclipRunSnapshot[] = [];

describe("parseGhPrMergeCommand", () => {
  it("parses a bare gh pr merge <PR>", () => {
    expect(parseGhPrMergeCommand("gh pr merge 460 --squash --delete-branch")).toBe(460);
  });

  it("parses gh pr merge preceded by cd and chained with &&", () => {
    expect(parseGhPrMergeCommand("cd /tmp/x && gh pr merge 460 --squash")).toBe(460);
  });

  it("parses gh pr merge chained with ; and trailing redirection", () => {
    expect(parseGhPrMergeCommand("gh pr merge 461 --squash 2>&1 | tee log")).toBe(461);
  });

  it("returns null when no gh pr merge is present", () => {
    expect(parseGhPrMergeCommand("gh pr view 460")).toBeNull();
    // paperclip:allow-git-push: negative fixture string — verifies the parser ignores unrelated remote-mutating commands.
    expect(parseGhPrMergeCommand("git push origin main")).toBeNull();
    expect(parseGhPrMergeCommand("")).toBeNull();
  });

  it("returns null for a malformed PR number", () => {
    expect(parseGhPrMergeCommand("gh pr merge abc")).toBeNull();
  });

  it("ignores wrappers like gh-pr-merge (hyphenated non-subcommand)", () => {
    expect(parseGhPrMergeCommand("gh-pr-merge --help")).toBeNull();
  });

  it("parses flags placed AFTER the PR number (--squash 460 --delete-branch)", () => {
    expect(parseGhPrMergeCommand("gh pr merge 460 --squash --delete-branch")).toBe(460);
  });

  it("parses flags placed BEFORE the PR number (--squash --delete-branch 460)", () => {
    expect(parseGhPrMergeCommand("gh pr merge --squash --delete-branch 460")).toBe(460);
  });

  it("parses --merge / --rebase / --admin variants with PR number after the flag", () => {
    expect(parseGhPrMergeCommand("gh pr merge --merge 461")).toBe(461);
    expect(parseGhPrMergeCommand("gh pr merge --rebase 462")).toBe(462);
    expect(parseGhPrMergeCommand("gh pr merge --admin 463")).toBe(463);
  });

  it("returns null when gh pr merge has no numeric PR number (current-branch form)", () => {
    expect(parseGhPrMergeCommand("gh pr merge --merge")).toBeNull();
    expect(parseGhPrMergeCommand("gh pr merge main")).toBeNull();
  });

  it("returns null for URL forms (no all-digit token after gh pr merge)", () => {
    expect(parseGhPrMergeCommand("gh pr merge https://github.com/foo/bar/pull/460")).toBeNull();
  });
});

describe("evaluatePreMergeGates — gate #1 (ticket state)", () => {
  it("allows when the ticket is in_review, assigned to cto and not blocked", () => {
    const r = evaluatePreMergeGates({ prNumber: 460, ticket: ctoTicket, activeRuns: noActiveRuns, lastCommentBody: null });
    expect(r).toEqual({ allow: true });
  });

  it("denies when no ticket resolves for the PR", () => {
    const r = evaluatePreMergeGates({ prNumber: 460, ticket: null, activeRuns: noActiveRuns, lastCommentBody: null });
    expect(r.allow).toBe(false);
    if (r.allow) return;
    expect(r.reason).toMatch(/Gate #1 failed: no Paperclip ticket/i);
  });

  it("denies when the ticket status is not in_review", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: { ...ctoTicket, status: "blocked" },
      activeRuns: noActiveRuns,
      lastCommentBody: null,
    });
    expect(r.allow).toBe(false);
    if (r.allow) return;
    expect(r.reason).toMatch(/status is 'blocked'/);
  });

  it("denies when the ticket assignee is not cto", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: { ...ctoTicket, assigneeAgentId: "mobile-developer" },
      activeRuns: noActiveRuns,
      lastCommentBody: null,
    });
    expect(r.allow).toBe(false);
    if (r.allow) return;
    expect(r.reason).toMatch(/assignee is 'mobile-developer'/);
  });

  it("denies when the ticket is blocked", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: { ...ctoTicket, blocked: true },
      activeRuns: noActiveRuns,
      lastCommentBody: null,
    });
    expect(r.allow).toBe(false);
    if (r.allow) return;
    expect(r.reason).toMatch(/is blocked/);
  });
});

describe("evaluatePreMergeGates — gate #2 (concurrent run race)", () => {
  it("denies when another active run of the same agent has a nextAction referencing the PR", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: [
        { id: "run-A", livenessState: "running", nextAction: "Review PR #460 then merge" },
      ],
      lastCommentBody: null,
    });
    expect(r.allow).toBe(false);
    if (r.allow) return;
    expect(r.reason).toMatch(/Gate #2 failed: another run of the cto agent/i);
  });

  it("allows when the other run is completed", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: [
        { id: "run-A", livenessState: "completed", nextAction: "Review PR #460 then merge" },
      ],
      lastCommentBody: null,
    });
    expect(r).toEqual({ allow: true });
  });

  it("allows when the active run does not reference the same PR", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: [
        { id: "run-A", livenessState: "running", nextAction: "Continue work on MGC-2356 (PR #459)" },
      ],
      lastCommentBody: null,
    });
    expect(r).toEqual({ allow: true });
  });
});

describe("evaluatePreMergeGates — gate #3 (hold signal in last comment)", () => {
  it("denies when the last comment contains 'NO procedo al merge'", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: noActiveRuns,
      lastCommentBody: "no procedo al merge hasta tener sign-off del operador",
    });
    expect(r.allow).toBe(false);
    if (r.allow) return;
    expect(r.reason).toMatch(/Gate #3 failed/);
  });

  it("denies when the last comment contains 'BLOQUEO pre-merge'", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: noActiveRuns,
      lastCommentBody: "bloqueo pre-merge: gate #1 sigue rojo",
    });
    expect(r.allow).toBe(false);
  });

  it("allows when the last comment is unrelated", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: noActiveRuns,
      lastCommentBody: "looks good to me — proceeding with merge",
    });
    expect(r).toEqual({ allow: true });
  });

  it("allows when there are no comments", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: noActiveRuns,
      lastCommentBody: null,
    });
    expect(r).toEqual({ allow: true });
  });
});

describe("fetchTicketForPr / fetchLastCommentBody / fetchActiveAgentRuns", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetchTicketForPr returns the first matching ticket", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { identifier: "MGC-9999", title: "other", description: "no PR mentioned" },
        { identifier: "MGC-2369", title: "[MGC-NEW]-[cto]-merge-lock", description: "Fix PR #460" },
      ],
    });
    const t = await fetchTicketForPr("http://x/api/", "k", 460);
    expect(t).toEqual({ identifier: "MGC-2369", status: "", assigneeAgentId: null, blocked: false });
  });

  it("fetchTicketForPr returns null when the API is unreachable", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const t = await fetchTicketForPr("http://x/api/", "k", 460);
    expect(t).toBeNull();
  });

  it("fetchLastCommentBody returns the lower-cased body of the most recent comment", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ body: "BLOQUEO pre-merge" }],
    });
    const body = await fetchLastCommentBody("http://x/api/", "k", "MGC-2369");
    expect(body).toBe("bloqueo pre-merge");
  });

  it("fetchLastCommentBody returns null when there are no comments", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    const body = await fetchLastCommentBody("http://x/api/", "k", "MGC-2369");
    expect(body).toBeNull();
  });

  it("fetchActiveAgentRuns maps the heartbeat-runs response into PaperclipRunSnapshot shape", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "run-1", status: "running", nextAction: "Review PR #460" },
        { id: "run-2", status: "completed", nextAction: null },
      ],
    });
    const runs = await fetchActiveAgentRuns("http://x/api/", "k", "cto", "company-1");
    expect(runs).toEqual([
      { id: "run-1", livenessState: "running", nextAction: "Review PR #460" },
      { id: "run-2", livenessState: "completed", nextAction: null },
    ]);
    // Hit the documented endpoint, not the non-existent /api/agents/:id/runs.
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("/api/companies/company-1/heartbeat-runs");
    expect(calledUrl).toContain("agentId=cto");
  });

  it("fetchActiveAgentRuns returns [] when the API responds with a non-array payload", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "not an array" }),
    });
    const runs = await fetchActiveAgentRuns("http://x/api/", "k", "cto", "company-1");
    expect(runs).toEqual([]);
  });
});

describe("buildPreMergeHookScript", () => {
  it("produces a script that parses with `bash -n`", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-pre-merge-hook-"));
    const scriptPath = path.join(dir, "seed", HOOK_RELATIVE_PATH);
    const script = buildPreMergeHookScript({ scriptPath });
    const target = path.join(dir, "hook.sh");
    writeFileSync(target, script, { mode: 0o755 });
    expect(() => execFileSync("bash", ["-n", target], { stdio: "pipe" })).not.toThrow();
  });

  it("encodes the deny JSON shape that Claude Code expects", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-pre-merge-hook-"));
    const scriptPath = path.join(dir, "seed", HOOK_RELATIVE_PATH);
    const script = buildPreMergeHookScript({ scriptPath });
    expect(script).toContain('"hookEventName":"PreToolUse"');
    expect(script).toContain('"permissionDecision":"deny"');
    expect(script).toContain("cat <<JSON");
    expect(script).toContain("deny() {");
    expect(script).toContain("extract_pr_number()");
    expect(script).toContain("Gate #1");
    expect(script).toContain("Gate #2");
    expect(script).toContain("Gate #3");
  });

  it("does not produce JS-style ${...} substitutions that bash would choke on", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-pre-merge-hook-"));
    const scriptPath = path.join(dir, "seed", HOOK_RELATIVE_PATH);
    const script = buildPreMergeHookScript({ scriptPath });
    // The script must not embed literal `${` followed by a JS expression that
    // would be ambiguous. We allow `${...}` (bash parameter expansion) and the
    // explicit `${safe_reason}` we ship ourselves, but we never want unescaped
    // bash arithmetic (`$((...))`) or command substitution (`$(...)`) that we
    // didn't write ourselves.
    expect(script).toMatch(/\$\{safe_reason\}/);
  });
});