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
    expect(parseGhPrMergeCommand("gh pr merge 460 --squash --delete-branch")).toEqual([460]);
  });

  it("parses gh pr merge preceded by cd and chained with &&", () => {
    expect(parseGhPrMergeCommand("cd /tmp/x && gh pr merge 460 --squash")).toEqual([460]);
  });

  it("parses gh pr merge chained with ; and trailing redirection", () => {
    expect(parseGhPrMergeCommand("gh pr merge 461 --squash 2>&1 | tee log")).toEqual([461]);
  });

  it("returns an empty array when no gh pr merge is present", () => {
    expect(parseGhPrMergeCommand("gh pr view 460")).toEqual([]);
    // paperclip:allow-git-push: negative fixture string — verifies the parser ignores unrelated remote-mutating commands.
    expect(parseGhPrMergeCommand("git push origin main")).toEqual([]);
    expect(parseGhPrMergeCommand("")).toEqual([]);
  });

  it("returns an empty array for a malformed PR number", () => {
    expect(parseGhPrMergeCommand("gh pr merge abc")).toEqual([]);
  });

  it("ignores wrappers like gh-pr-merge (hyphenated non-subcommand)", () => {
    expect(parseGhPrMergeCommand("gh-pr-merge --help")).toEqual([]);
  });

  it("parses flags placed AFTER the PR number (--squash 460 --delete-branch)", () => {
    expect(parseGhPrMergeCommand("gh pr merge 460 --squash --delete-branch")).toEqual([460]);
  });

  it("parses flags placed BEFORE the PR number (--squash --delete-branch 460)", () => {
    expect(parseGhPrMergeCommand("gh pr merge --squash --delete-branch 460")).toEqual([460]);
  });

  it("parses --merge / --rebase / --admin variants with PR number after the flag", () => {
    expect(parseGhPrMergeCommand("gh pr merge --merge 461")).toEqual([461]);
    expect(parseGhPrMergeCommand("gh pr merge --rebase 462")).toEqual([462]);
    expect(parseGhPrMergeCommand("gh pr merge --admin 463")).toEqual([463]);
  });

  it("returns an empty array when gh pr merge has no numeric PR number (current-branch form)", () => {
    expect(parseGhPrMergeCommand("gh pr merge --merge")).toEqual([]);
    expect(parseGhPrMergeCommand("gh pr merge main")).toEqual([]);
  });

  it("returns an empty array for URL forms (no all-digit token after gh pr merge)", () => {
    expect(parseGhPrMergeCommand("gh pr merge https://github.com/foo/bar/pull/460")).toEqual([]);
  });

  it("returns every PR across multiple chained `gh pr merge` segments (compound merge)", () => {
    expect(parseGhPrMergeCommand("gh pr merge 459 --squash && gh pr merge 460 --delete-branch")).toEqual([459, 460]);
    expect(parseGhPrMergeCommand("gh pr merge 459; gh pr merge 460")).toEqual([459, 460]);
    expect(parseGhPrMergeCommand("cd repo && gh pr merge 459 --squash && cd repo2 && gh pr merge 460")).toEqual([459, 460]);
  });

  it("returns an empty array when ANY chained `gh pr merge` segment lacks a numeric PR", () => {
    expect(parseGhPrMergeCommand("gh pr merge 459 --squash && gh pr merge main")).toEqual([]);
    expect(parseGhPrMergeCommand("gh pr merge --merge && gh pr merge 460")).toEqual([]);
  });

  it("preserves order and duplicates when the same PR is repeated in a compound command", () => {
    expect(parseGhPrMergeCommand("gh pr merge 460 && gh pr merge 460 --squash")).toEqual([460, 460]);
  });

  it("matches a TAB between `gh pr merge` and the PR number (Greptile P1 #6 regression)", () => {
    // Reproduces Greptile round 4 finding: the bash extractor previously
    // required a literal space after `gh pr merge`, so `gh pr merge\t460`
    // bypassed the gate. The TS parser is symmetric.
    expect(parseGhPrMergeCommand("gh pr merge\t460 --squash")).toEqual([460]);
  });

  it("matches a TAB between any pair of tokens in `gh pr merge` (Greptile P1 #6 round 5)", () => {
    // Reproduces Greptile round 5 finding: tabs between `gh`/`pr`/`merge`
    // used to bypass because the substring `gh pr merge` did not appear.
    expect(parseGhPrMergeCommand("gh\tpr merge 460 --squash")).toEqual([460]);
    expect(parseGhPrMergeCommand("gh pr\tmerge 460 --squash")).toEqual([460]);
    expect(parseGhPrMergeCommand("gh\tpr\tmerge 460 --squash")).toEqual([460]);
  });

  it("refuses indirect `gh` invocations built by shell expansion (Greptile P1 round 6)", () => {
    // Reproduces the finding: the hook sees the PRE-expansion string, so
    // `$g pr merge 460` carries no literal `gh` and used to fall through to the
    // empty-result allow — while bash expanded it and merged unchecked. An
    // empty array is the deny-by-default signal for an unresolvable target.
    expect(parseGhPrMergeCommand("g=gh; $g pr merge 460")).toEqual([]);
    expect(parseGhPrMergeCommand("${GH} pr merge 460 --squash")).toEqual([]);
    expect(parseGhPrMergeCommand("$(which gh) pr merge 460")).toEqual([]);
    expect(parseGhPrMergeCommand("`which gh` pr merge 460")).toEqual([]);
    // Also poisons an otherwise-resolvable compound: one unauditable segment
    // must sink the whole command, not just its own.
    expect(parseGhPrMergeCommand("gh pr merge 459 && $g pr merge 460")).toEqual([]);
  });

  it("still allows commands that merely mention `pr merge` as text", () => {
    // Guards the fix above against over-blocking: without a shell-expansion
    // command word there is no indirect `gh` invocation to worry about.
    expect(parseGhPrMergeCommand('git commit -m "pr merge fix"')).toEqual([]);
    expect(parseGhPrMergeCommand("echo pr merge")).toEqual([]);
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

  it("allows when the only active run referencing the PR is the current run (no self-conflict)", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: [
        { id: "run-self", livenessState: "running", nextAction: "Merge PR #460 if all gates pass" },
      ],
      lastCommentBody: null,
      currentRunId: "run-self",
    });
    expect(r).toEqual({ allow: true });
  });

  it("still denies when a DIFFERENT active run references the PR even if currentRunId is set", () => {
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: [
        { id: "run-self", livenessState: "running", nextAction: "Merge PR #460" },
        { id: "run-other", livenessState: "running", nextAction: "Review PR #460 then merge" },
      ],
      lastCommentBody: null,
      currentRunId: "run-self",
    });
    expect(r.allow).toBe(false);
    if (r.allow) return;
    expect(r.reason).toMatch(/Gate #2 failed: another run of the cto agent \(id=run-other/);
  });

  it("falls back to denying when currentRunId is missing and the only run references the PR", () => {
    // Backwards compatibility: when the caller does not provide currentRunId
    // the gate must still deny the self-conflict, so the harness that hasn't
    // been updated yet does not accidentally widen the allow path.
    const r = evaluatePreMergeGates({
      prNumber: 460,
      ticket: ctoTicket,
      activeRuns: [
        { id: "run-self", livenessState: "running", nextAction: "Merge PR #460" },
      ],
      lastCommentBody: null,
    });
    expect(r.allow).toBe(false);
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
    expect(script).toContain("extract_pr_numbers()");
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

  it("filters PAPERCLIP_RUN_ID out of the race check (self-block guard)", () => {
    // Regression test for the post-mortem MGC-2348 #5 control bug: a CTO run
    // whose own nextAction references the PR must NOT be denied as a
    // self-conflict. The bash script reads PAPERCLIP_RUN_ID and ignores the
    // matching run.id from the heartbeat-runs payload.
    const script = buildPreMergeHookScript({ scriptPath: "/tmp/hook.sh" });
    expect(script).toContain('RUN_ID="${PAPERCLIP_RUN_ID:-}"');
    expect(script).toMatch(/current_run='\$\{RUN_ID\}'/);
    expect(script).toMatch(/if current_run and run_id == current_run:\s*\n\s*continue/);
  });

  it("loops over every PR in a compound `gh pr merge` command and gates each independently", () => {
    const script = buildPreMergeHookScript({ scriptPath: "/tmp/hook.sh" });
    // The script must wrap the gate evaluation in `for PR_NUMBER in $PR_NUMBERS`
    // so a compound merge like `gh pr merge 459 && gh pr merge 460` requires
    // BOTH PRs to pass — partial approval is never sufficient.
    expect(script).toContain("for PR_NUMBER in $PR_NUMBERS; do");
    expect(script).toContain("done");
    expect(script).toMatch(
      /extract_pr_numbers\(\) \{[\s\S]*?grep -qE 'gh\[\[:space:\]\]\+pr\[\[:space:\]\]\+merge\(\[\[:space:\]\]\|\$\)'/,
    );
    // The no-literal-`gh` branch must deny indirect expansions rather than
    // `continue` past them (Greptile P1 round 6).
    expect(script).toMatch(/__unresolvable_merge__[\s\S]*?continue/);
  });
});

describe("buildPreMergeHookScript — end-to-end race condition (integration)", () => {
  // Drive the actual generated bash script with a fake `curl` so we exercise
  // the full pipeline (PR extraction → API lookup → race check → comment
  // gate) without a live Paperclip server. This satisfies the AC for a
  // "test de integración que simule race condition" and locks in the
  // behaviour both Greptile P1 findings demanded.
  const binDir = mkdtempSync(path.join(tmpdir(), "paperclip-hook-bin-"));
  const curlPath = path.join(binDir, "curl");

  function writeFakeCurl(routes: Record<string, string>): void {
    const lines: string[] = [
      "#!/usr/bin/env bash",
      "# Capture the URL (the last positional arg of curl) — earlier args are flags and headers.",
      "url=\"\"",
      "for arg in \"$@\"; do url=\"$arg\"; done",
      'case "$url" in',
    ];
    for (const [substr, body] of Object.entries(routes)) {
      const escaped = body.replace(/'/g, "'\\''");
      lines.push(`  *"${substr}"*) echo '${escaped}' ;;`);
    }
    lines.push("  *) echo '[]' ;;");
    lines.push("esac");
    writeFileSync(curlPath, lines.join("\n") + "\n", { mode: 0o755 });
  }

  function runHook(args: {
    command: string;
    runId: string;
    agentId: string;
    companyId: string;
    routes: Record<string, string>;
  }): { stdout: string; stderr: string; status: number } {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-hook-"));
    const scriptPath = path.join(dir, "hook.sh");
    const script = buildPreMergeHookScript({ scriptPath });
    writeFileSync(scriptPath, script, { mode: 0o755 });
    writeFakeCurl(args.routes);
    const payload = JSON.stringify({ tool_input: { command: args.command } });
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PAPERCLIP_API_URL: "http://paperclip.test/api",
      PAPERCLIP_API_KEY: "test-key",
      PAPERCLIP_AGENT_ID: args.agentId,
      PAPERCLIP_COMPANY_ID: args.companyId,
      PAPERCLIP_RUN_ID: args.runId,
    };
    try {
      const out = execFileSync("bash", [scriptPath], {
        input: payload,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as Buffer;
      return { stdout: out.toString("utf8"), stderr: "", status: 0 };
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number | null };
      return {
        stdout: e.stdout?.toString("utf8") ?? "",
        stderr: e.stderr?.toString("utf8") ?? "",
        status: e.status ?? 1,
      };
    }
  }

  const ctoTicket = JSON.stringify([
    { identifier: "MGC-2369", title: "[MGC-NEW]", description: "PR #460 mentioned", status: "in_review", assigneeAgentId: "cto", blocked: false },
  ]);
  const blockedTicket459 = JSON.stringify([
    { identifier: "MGC-2208", title: "[fix]", description: "PR #459 mentioned", status: "in_review", assigneeAgentId: "cto", blocked: true },
  ]);
  const emptyRuns = "[]";
  const selfRun = JSON.stringify([
    { id: "run-self", status: "running", nextAction: "Merge PR #460 if gates pass" },
  ]);
  const otherRun = JSON.stringify([
    { id: "run-other", status: "running", nextAction: "Review PR #460 then merge" },
  ]);
  const commentOk = JSON.stringify([{ body: "ok proceed" }]);

  it("allows a single gh pr merge when all three gates pass", () => {
    const r = runHook({
      command: "gh pr merge 460 --squash --delete-branch",
      runId: "run-self",
      agentId: "cto",
      companyId: "co-1",
      routes: {
        "/api/issues?search=PR%23460": ctoTicket,
        "/heartbeat-runs": emptyRuns,
        "/comments": commentOk,
      },
    });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it("allows a merge whose only heartbeat-runs entry is the current run (Bug B regression)", () => {
    // Reproduces Greptile P1 #4: when the heartbeat-runs endpoint returned the
    // CURRENT run's nextAction referencing the PR, the gate incorrectly denied
    // a legitimate merge as a self-conflict. PAPERCLIP_RUN_ID filtering now
    // excludes the calling run, so the same scenario allows the merge.
    const r = runHook({
      command: "gh pr merge 460 --squash",
      runId: "run-self",
      agentId: "cto",
      companyId: "co-1",
      routes: {
        "/api/issues?search=PR%23460": ctoTicket,
        "/heartbeat-runs": selfRun,
        "/comments": commentOk,
      },
    });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it("denies a compound merge when only the first PR is blocked (Bug A regression)", () => {
    // Reproduces Greptile P1 #3: `gh pr merge 459 && gh pr merge 460` must
    // require BOTH PRs to pass. Here PR 459 is blocked and PR 460 is fine, so
    // the whole command must be denied — the previous implementation only
    // checked the LAST `gh pr merge` target.
    const r = runHook({
      command: "gh pr merge 459 --squash && gh pr merge 460 --delete-branch",
      runId: "run-self",
      agentId: "cto",
      companyId: "co-1",
      routes: {
        "/api/issues?search=PR%23459": blockedTicket459,
        "/api/issues?search=PR%23460": ctoTicket,
        "/heartbeat-runs": emptyRuns,
        "/comments": commentOk,
      },
    });
    expect(r.stdout).toMatch(/"permissionDecision":"deny"/);
    expect(r.stdout).toMatch(/Gate #1/);
    expect(r.stdout).toMatch(/MGC-2208/);
    expect(r.status).toBe(0); // Claude Code reads the JSON, not the exit code.
  });

  it("denies a compound merge when ANY PR fails (not just the last one)", () => {
    // Compound where PR 460 (last) is approved but PR 459 (first) has no
    // ticket at all. The OLD parser looked at PR 460 only and allowed the
    // whole command. The fix checks BOTH.
    const r = runHook({
      command: "cd /tmp/repo && gh pr merge 459 --squash && gh pr merge 460 --delete-branch",
      runId: "run-self",
      agentId: "cto",
      companyId: "co-1",
      routes: {
        "/api/issues?search=PR%23459": "[]",
        "/api/issues?search=PR%23460": ctoTicket,
        "/heartbeat-runs": emptyRuns,
        "/comments": commentOk,
      },
    });
    expect(r.stdout).toMatch(/"permissionDecision":"deny"/);
    expect(r.stdout).toMatch(/Gate #1/);
    expect(r.stdout).toMatch(/no Paperclip ticket references PR #459/);
  });

  it("denies when ANY segment of a compound `gh pr merge` lacks a numeric PR (Greptile P1 #5 regression)", () => {
    // Greptile round 3: `gh pr merge 459 --squash && gh pr merge main` was
    // silently allowed because the second segment had no numeric PR and the
    // extractor returned empty, skipping gate evaluation for 459 entirely.
    // The fix: extractor emits a sentinel for unresolvable segments so the
    // script can deny the whole compound command explicitly.
    const r = runHook({
      command: "gh pr merge 459 --squash && gh pr merge main",
      runId: "run-self",
      agentId: "cto",
      companyId: "co-1",
      routes: {
        "/api/issues?search=PR%23459": ctoTicket,
        "/heartbeat-runs": emptyRuns,
        "/comments": commentOk,
      },
    });
    expect(r.stdout).toMatch(/"permissionDecision":"deny"/);
    expect(r.stdout).toMatch(/numeric PR/);
  });

  it("denies an indirect `gh` invocation built by shell expansion (Greptile P1 round 6)", () => {
    // Drives the REAL generated bash: `$g pr merge 460` reaches the gh binary
    // through expansion, so the hook's literal-string match found nothing and
    // fell through to allow — while bash expanded it and merged unchecked.
    for (const command of [
      "g=gh; $g pr merge 460 --squash",
      "${GH} pr merge 460 --squash",
      "$(which gh) pr merge 460",
    ]) {
      const r = runHook({
        command,
        runId: "run-self",
        agentId: "cto",
        companyId: "co-1",
        routes: {
          "/api/issues?search=PR%23460": ctoTicket,
          "/heartbeat-runs": emptyRuns,
          "/comments": commentOk,
        },
      });
      expect(r.stdout, command).toMatch(/"permissionDecision":"deny"/);
      expect(r.stdout, command).toMatch(/Gate #1/);
    }
  });

  it("still allows an unrelated command that merely mentions `pr merge`", () => {
    // Guards the fix above from over-blocking ordinary Bash tool calls.
    const r = runHook({
      command: 'git commit -m "pr merge fix"',
      runId: "run-self",
      agentId: "cto",
      companyId: "co-1",
      routes: { "/heartbeat-runs": emptyRuns, "/comments": commentOk },
    });
    expect(r.stdout).not.toMatch(/"permissionDecision":"deny"/);
  });

  it("denies when a DIFFERENT concurrent run holds the PR (race condition simulated)", () => {
    // AC requirement: 3 validaciones activas y testeables con un test de
    // integración que simule race condition.
    const r = runHook({
      command: "gh pr merge 460 --squash",
      runId: "run-self",
      agentId: "cto",
      companyId: "co-1",
      routes: {
        "/api/issues?search=PR%23460": ctoTicket,
        "/heartbeat-runs": otherRun,
        "/comments": commentOk,
      },
    });
    expect(r.stdout).toMatch(/"permissionDecision":"deny"/);
    expect(r.stdout).toMatch(/Gate #2/);
    expect(r.stdout).toMatch(/run-other/);
  });

  it("denies when the latest ticket comment contains a hold signal", () => {
    const commentHold = JSON.stringify([{ body: "NO procedo al merge sin DevOps sign-off" }]);
    const r = runHook({
      command: "gh pr merge 460 --squash",
      runId: "run-self",
      agentId: "cto",
      companyId: "co-1",
      routes: {
        "/api/issues?search=PR%23460": ctoTicket,
        "/heartbeat-runs": emptyRuns,
        "/comments": commentHold,
      },
    });
    expect(r.stdout).toMatch(/"permissionDecision":"deny"/);
    expect(r.stdout).toMatch(/Gate #3/);
  });
});