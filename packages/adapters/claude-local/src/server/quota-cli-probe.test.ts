import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeCliUsagePanelError,
  ClaudeCliUsageProbeError,
  ClaudeUsageApiError,
  captureClaudeCliUsageText,
  claudeCliPromptLooksReady,
  claudeCliUsagePanelLooksComplete,
  describeClaudeQuotaHint,
  detectClaudeCliStartupBlocker,
  fetchClaudeQuota,
  getQuotaWindows,
  parseClaudeCliUsageText,
  resetClaudeQuotaFailureLogForTests,
} from "./quota.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), exec: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.read } }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.exec }),
  spawn: mocks.spawn,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetClaudeQuotaFailureLogForTests();
});

/** The child's stdin pipe: a stream that records writes and can report a broken pipe. */
class FakeStdin extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
}

/** A stand-in for the `script` pty wrapper around `claude`. Tests feed it terminal output and watch the keystrokes it receives. */
class FakeClaudeCli extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
  kill = vi.fn(() => true);
  // No pid: the default process-group kill must never reach a real process from a test.
  pid: number | undefined = undefined;
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
  print(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }
  typed(): string[] {
    return this.stdin.write.mock.calls.map((call) => String(call[0]));
  }
}

// Terminal text as Claude Code 2.1.289 renders it under `script`, with ANSI
// sequences removed. Each fixture is one observed REPL state.
const BANNER =
  " ▐▛███▜▌   Claude Code v2.1.289\r\n" +
  "▝▜█████▛▘  Fable 5.1 with xhigh effort · Claude Max\r\n" +
  "  ▘▘ ▝▝    ~/Projects\r\n";
const PROMPT =
  "────────────────────────────────────────\r\n" +
  "❯ Try \"fix typecheck errors\"\r\n" +
  "────────────────────────────────────────\r\n" +
  "  ? for shortcuts\r\n";
const FOOTER_WITH_PERCENT = "  Fable 5.1 | Projects | effort xhigh | think on | ctx -- | 5h 71% (1h58m) | …\r\n";
const TRUST_DIALOG =
  "Accessing workspace:\r\n\r\n/Users/operator/Projects\r\n\r\n" +
  "Quick safety check: Is this a project you created or one you trust? (Like your\r\n" +
  "own code, a well-known open source project, or work from your team). If not,\r\n" +
  "take a moment to review what's in this folder first.\r\n\r\n" +
  "Claude Code'll be able to read, edit, and execute files here.\r\n\r\n" +
  "❯ No, exit\r\n  Yes, I trust this folder\r\n\r\nEnter to confirm · Esc to cancel\r\n";
// The same dialog as the pty delivers it: the REPL positions the cursor instead
// of writing spaces, so most words run together once ANSI sequences are gone.
const TRUST_DIALOG_SPACELESS =
  "Accessingworkspace:\r\n/Users/operator/Projects\r\n" +
  "Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?(Likeyour\r\n" +
  "owncode,awell-knownopensourceproject,orworkfromyourteam).Ifnot,\r\n" +
  "ClaudeCode'llbeabletoread,edit,andexecutefileshere.\r\n" +
  "❯No,exit\r\nYes,Itrustthisfolder\r\nEntertoconfirm·Esctocancel\r\n";
const LOGIN_DIALOG = "Select login method:\r\n❯ 1. Claude account with subscription\r\n  2. Anthropic Console account\r\n";
// The `/usage` panel of Claude Code 2.1.289 under `script`, ANSI removed, as captured on macOS.
const USAGE_PANEL_2_1_289 =
  " ▐▛███▛█Claude Codev2.1.289\r\n" +
  "▝▜██████▀Fable 5.1 with xhigh effort · Claude Max\r\n" +
  "❯ /usage                                                                        \r\n" +
  "✻Moseying… \r\n" +
  "   Settings  Status   Config   Usage   Stats\r\n" +
  "Session\r\nTotal cost:            $0.0000\r\nTotal duration (API):  0s\r\n" +
  "Usage:                 0 input, 0 output, 0 cache read, 0 cache write\r\n" +
  "Current session\r\n" +
  "█████████████████████████████▌                    59%used\r\n" +
  "Resets 3:09pm (America/Cuiaba)\r\n" +
  "  Current week (all models)\r\n" +
  "███████▌                                          15%used\r\n" +
  "   Resets Oct 11 at 7:59am (America/Cuiaba)\r\n" +
  "   Current week (Fable)\r\n" +
  "██████████▌                                       21%used\r\n" +
  " Resets Oct 11 at 7:59am (America/Cuiaba)                   ↓\r\n" +
  "Plugin skill-listing footprint\r\n" +
  "What each plugin's skill descriptions add to the system prompt (cached \r\n" +
  "private-equity              10 skills · ~246 tok/turn\r\n";
const USAGE_LOADING = "Settings:  Status   Config   Usage\r\nLoading usage…\r\n";
const USAGE_PANEL =
  "Settings:  Status   Config   Usage\r\n" +
  "Current session\r\n71% used\r\nResets 3pm (Europe/Lisbon)\r\n\r\n" +
  "Current week (all models)\r\n12% used\r\nResets Oct 8 at 9am (Europe/Lisbon)\r\n\r\n" +
  "Current week (Sonnet only)\r\n0% used\r\nResets Oct 8 at 9am (Europe/Lisbon)\r\n\r\n" +
  "Extra usage\r\nExtra usage not enabled • /extra-usage to enable\r\n";

const ESC = "\u001b";
const CTRL_C = "\u0003";

describe("REPL state detection", () => {
  it("does not treat the banner alone as a ready prompt", () => {
    expect(claudeCliPromptLooksReady(BANNER)).toBe(false);
  });
  it("recognises the rendered prompt", () => {
    expect(claudeCliPromptLooksReady(BANNER + PROMPT)).toBe(true);
    expect(claudeCliPromptLooksReady("❯ Try \"edit <filepath> to...\"\n")).toBe(true);
    expect(claudeCliPromptLooksReady("⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe(true);
  });
  it("does not mistake a selection cursor for the prompt", () => {
    expect(claudeCliPromptLooksReady("❯ No, exit\n  Yes, I trust this folder\n")).toBe(false);
    expect(claudeCliPromptLooksReady(TRUST_DIALOG_SPACELESS)).toBe(false);
  });
  it("names the folder-trust and login dialogs", () => {
    expect(detectClaudeCliStartupBlocker(TRUST_DIALOG)).toBe("trust_prompt");
    expect(detectClaudeCliStartupBlocker(TRUST_DIALOG_SPACELESS)).toBe("trust_prompt");
    expect(detectClaudeCliStartupBlocker(LOGIN_DIALOG)).toBe("login_required");
    expect(detectClaudeCliStartupBlocker(BANNER + PROMPT)).toBeNull();
  });
  it("does not count the footer percentage as a rendered usage panel", () => {
    expect(claudeCliUsagePanelLooksComplete(PROMPT + FOOTER_WITH_PERCENT)).toBe(false);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + FOOTER_WITH_PERCENT + USAGE_LOADING)).toBe(false);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + FOOTER_WITH_PERCENT + "Current session\r\nCurrent week (all models)\r\n")).toBe(false);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + FOOTER_WITH_PERCENT + USAGE_PANEL)).toBe(true);
  });
  it("treats a usage load failure as a finished panel", () => {
    expect(claudeCliUsagePanelLooksComplete(PROMPT + "Failed to load usage data")).toBe(true);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + "Settings: Usage\r\nToken has expired\r\n")).toBe(true);
  });
  it("waits for every row that has started to show its value", () => {
    const sessionRow = "Current session\r\n71% used\r\nResets 3pm (Europe/Lisbon)\r\n";
    const weekRow = "Current week (all models)\r\n12% used\r\nResets Oct 8 at 9am (Europe/Lisbon)\r\n";
    expect(claudeCliUsagePanelLooksComplete(PROMPT + sessionRow)).toBe(false);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + sessionRow + "Current week (all models)\r\n")).toBe(false);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + sessionRow + weekRow)).toBe(true);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + sessionRow + weekRow + "Current week (Fable)\r\n")).toBe(false);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + sessionRow + weekRow + "Extra usage\r\n")).toBe(false);
    expect(claudeCliUsagePanelLooksComplete(PROMPT + sessionRow + weekRow + "Extra usage\r\nExtra usage not enabled\r\n")).toBe(true);
  });
  it("stays complete when a redraw repeats a label whose value it already holds", () => {
    expect(claudeCliUsagePanelLooksComplete(USAGE_PANEL_2_1_289 + "Current week (all models)\r\n")).toBe(true);
  });
});

describe("parseClaudeCliUsageText on a Claude Code 2.1.289 capture", () => {
  it("reads every window row, including a per-model weekly window", () => {
    expect(claudeCliUsagePanelLooksComplete(USAGE_PANEL_2_1_289)).toBe(true);
    const windows = parseClaudeCliUsageText(USAGE_PANEL_2_1_289);
    expect(windows.map((window) => [window.label, window.usedPercent, window.detail])).toEqual([
      ["Current session", 59, "Resets 3:09pm (America/Cuiaba)"],
      ["Current week (all models)", 15, "Resets Oct 11 at 7:59am (America/Cuiaba)"],
      ["Current week (Fable)", 21, "Resets Oct 11 at 7:59am (America/Cuiaba) ↓"],
    ]);
  });
  it("keeps the latest drawing of a row the REPL redrew", () => {
    const redrawn = USAGE_PANEL_2_1_289 + "Current session\r\n██████████████████████████████▌ 61%used\r\nResets 3:09pm (America/Cuiaba)\r\n";
    const windows = parseClaudeCliUsageText(redrawn);
    expect(windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Current session", 61],
      ["Current week (all models)", 15],
      ["Current week (Fable)", 21],
    ]);
  });
  it("keeps a row's last value when a redraw repeats its label before the new value lands", () => {
    const halfDrawn = USAGE_PANEL_2_1_289 + "Current week (all models)\r\nCurrent week (Fable)\r\n";
    const windows = parseClaudeCliUsageText(halfDrawn);
    expect(windows.map((window) => [window.label, window.usedPercent, window.detail])).toEqual([
      ["Current session", 59, "Resets 3:09pm (America/Cuiaba)"],
      ["Current week (all models)", 15, "Resets Oct 11 at 7:59am (America/Cuiaba)"],
      ["Current week (Fable)", 21, "Resets Oct 11 at 7:59am (America/Cuiaba) ↓"],
    ]);
  });
});

describe("captureClaudeCliUsageText", () => {
  it("types /usage only after the prompt renders and closes the panel only after it completes", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-leak-into-the-cli");
    const cli = new FakeClaudeCli();
    const spawn = vi.fn(() => cli.asChild());
    const kill = vi.fn();

    const capture = captureClaudeCliUsageText({ spawn, kill, cwd: "/srv/paperclip", settleMs: 400, exitGraceMs: 1_500 });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; detached: boolean },
    ];
    expect(command).toBe("sh");
    expect(args.join(" ")).toContain("script");
    expect(args.join(" ")).toContain("claude --tools");
    expect(options.cwd).toBe("/srv/paperclip");
    expect(options.detached).toBe(true);
    expect(Object.keys(options.env).some((key) => key.startsWith("ANTHROPIC_"))).toBe(false);
    expect(options.env.TERM).toBeTruthy();

    cli.print(BANNER);
    expect(cli.typed()).toEqual([]);

    cli.print(PROMPT);
    expect(cli.typed()).toEqual(["/usage\r"]);

    cli.print(FOOTER_WITH_PERCENT);
    cli.print(USAGE_LOADING);
    expect(cli.typed()).toEqual(["/usage\r"]);

    cli.print(USAGE_PANEL);
    expect(cli.typed()).toEqual(["/usage\r"]);
    await vi.advanceTimersByTimeAsync(400);
    expect(cli.typed()).toEqual(["/usage\r", ESC]);
    await vi.advanceTimersByTimeAsync(240);
    expect(cli.typed()).toEqual(["/usage\r", ESC, CTRL_C, CTRL_C]);
    expect(cli.stdin.end).toHaveBeenCalledTimes(1);

    cli.emit("close", 0);
    const text = await capture;
    expect(text).toContain("Current session");
    expect(text).toContain("Extra usage not enabled");
    expect(kill).not.toHaveBeenCalled();
  });

  it("keeps the panel open while a row is still loading", async () => {
    vi.useFakeTimers();
    const cli = new FakeClaudeCli();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild(), kill: vi.fn(), settleMs: 400, exitGraceMs: 500 });
    cli.print(BANNER + PROMPT);
    cli.print("Settings:  Status   Config   Usage\r\nCurrent session\r\n71% used\r\nResets 3pm (Europe/Lisbon)\r\n\r\nCurrent week (all models)\r\n");
    await vi.advanceTimersByTimeAsync(1_000);
    // The weekly row has no value yet: no Escape, however long the pause.
    expect(cli.typed()).toEqual(["/usage\r"]);

    cli.print("12% used\r\nResets Oct 8 at 9am (Europe/Lisbon)\r\n\r\nExtra usage\r\n");
    await vi.advanceTimersByTimeAsync(1_000);
    // Extra usage has started but shows nothing yet.
    expect(cli.typed()).toEqual(["/usage\r"]);

    cli.print("Extra usage not enabled • /extra-usage to enable\r\n");
    await vi.advanceTimersByTimeAsync(399);
    expect(cli.typed()).toEqual(["/usage\r"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cli.typed()).toEqual(["/usage\r", ESC]);
    cli.emit("close", 0);
    const windows = parseClaudeCliUsageText(await capture);
    expect(windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Current session", 71],
      ["Current week (all models)", 12],
      ["Extra usage", null],
    ]);
  });

  it("restarts the quiet time when the panel redraws", async () => {
    vi.useFakeTimers();
    const cli = new FakeClaudeCli();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild(), kill: vi.fn(), settleMs: 400, exitGraceMs: 500 });
    cli.print(BANNER + PROMPT + USAGE_PANEL);
    await vi.advanceTimersByTimeAsync(300);
    // A redraw repeats the label; its new value is on its way.
    cli.print("Current session\r\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(cli.typed()).toEqual(["/usage\r"]);
    cli.print("72% used\r\n");
    await vi.advanceTimersByTimeAsync(400);
    expect(cli.typed()).toEqual(["/usage\r", ESC]);
    cli.emit("close", 0);
    const windows = parseClaudeCliUsageText(await capture);
    expect(windows.find((window) => window.label === "Current session")?.usedPercent).toBe(72);
  });

  it("survives a broken pipe on the CLI's stdin", async () => {
    const cli = new FakeClaudeCli();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild(), kill: vi.fn() });
    cli.print(BANNER + PROMPT);
    expect(cli.typed()).toEqual(["/usage\r"]);
    // The REPL exited as the keystroke was written. Node reports that on the
    // stream; with no listener the emit would throw and take the server down.
    expect(() => cli.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
    cli.emit("close", 1);
    const error = (await capture.then(() => null, (reason: unknown) => reason)) as ClaudeCliUsageProbeError;
    expect(error.reason).toBe("exited_before_usage");
  });

  it("returns the captured panel even when the CLI ignores Ctrl-C", async () => {
    vi.useFakeTimers();
    const cli = new FakeClaudeCli();
    const kill = vi.fn();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild(), kill, settleMs: 100, exitGraceMs: 500 });
    cli.print(BANNER + PROMPT);
    cli.print(USAGE_PANEL);
    await vi.advanceTimersByTimeAsync(100 + 240 + 500);
    await expect(capture).resolves.toContain("Current week (all models)");
    expect(kill).toHaveBeenCalledWith(cli, "SIGTERM");
  });

  it("stops at the folder-trust dialog without typing anything", async () => {
    const cli = new FakeClaudeCli();
    const kill = vi.fn();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild(), kill, cwd: "/Users/operator/Projects" });
    cli.print(TRUST_DIALOG);
    const error = await capture.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClaudeCliUsageProbeError);
    expect((error as ClaudeCliUsageProbeError).reason).toBe("trust_prompt");
    expect((error as Error).message).toContain("/Users/operator/Projects");
    expect((error as ClaudeCliUsageProbeError).transcript).toContain("Quick safety check");
    expect(cli.typed()).toEqual([]);
    expect(kill).toHaveBeenCalledWith(cli, "SIGTERM");
  });

  it("stops at the login dialog without typing anything", async () => {
    const cli = new FakeClaudeCli();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild() });
    cli.print(LOGIN_DIALOG);
    const error = await capture.then(() => null, (reason: unknown) => reason);
    expect((error as ClaudeCliUsageProbeError).reason).toBe("login_required");
    expect(cli.typed()).toEqual([]);
  });

  it("gives up when the prompt never renders, with a message that names the wait and not the command", async () => {
    vi.useFakeTimers();
    const cli = new FakeClaudeCli();
    const kill = vi.fn();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild(), kill, promptTimeoutMs: 3_000 });
    const outcome = capture.then(() => null, (reason: unknown) => reason);
    cli.print(BANNER);
    await vi.advanceTimersByTimeAsync(3_000);
    const error = (await outcome) as ClaudeCliUsageProbeError;
    expect(error.reason).toBe("prompt_timeout");
    expect(error.message).toBe("The Claude CLI did not show its prompt within 3s.");
    expect(error.message).not.toMatch(/sh -c|script|printf|sleep/);
    expect(cli.typed()).toEqual([]);
    expect(kill).toHaveBeenCalledWith(cli, "SIGTERM");
  });

  it("gives up when /usage renders nothing in time", async () => {
    vi.useFakeTimers();
    const cli = new FakeClaudeCli();
    const kill = vi.fn();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild(), kill, usageTimeoutMs: 2_000 });
    const outcome = capture.then(() => null, (reason: unknown) => reason);
    cli.print(BANNER + PROMPT);
    expect(cli.typed()).toEqual(["/usage\r"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(((await outcome) as ClaudeCliUsageProbeError).reason).toBe("usage_timeout");
    expect(kill).toHaveBeenCalledWith(cli, "SIGTERM");
  });

  it("reports an early exit as such", async () => {
    const cli = new FakeClaudeCli();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild() });
    cli.print(BANNER);
    cli.emit("close", 1);
    const error = (await capture.then(() => null, (reason: unknown) => reason)) as ClaudeCliUsageProbeError;
    expect(error.reason).toBe("exited_before_prompt");
    expect(error.message).toBe("The Claude CLI exited before it showed a prompt.");
  });

  it("reports a missing binary without the command line", async () => {
    const cli = new FakeClaudeCli();
    const capture = captureClaudeCliUsageText({ spawn: () => cli.asChild() });
    cli.emit("error", Object.assign(new Error("spawn script ENOENT"), { code: "ENOENT" }));
    const error = (await capture.then(() => null, (reason: unknown) => reason)) as ClaudeCliUsageProbeError;
    expect(error.reason).toBe("spawn_error");
    expect(error.message).toBe("The `claude` command or the `script` pty helper was not found on PATH.");
  });
});

describe("fetchClaudeQuota", () => {
  it("adds a model-scoped weekly window from the limits list, as the CLI panel shows it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 87, resets_at: "2026-10-04T19:09:59+00:00" },
          seven_day: { utilization: 21, resets_at: "2026-10-11T11:59:59+00:00" },
          seven_day_sonnet: null,
          seven_day_opus: null,
          limits: [
            { kind: "session", percent: 87, resets_at: "2026-10-04T19:09:59+00:00", scope: null },
            { kind: "weekly_all", percent: 21, resets_at: "2026-10-11T11:59:59+00:00", scope: null },
            { kind: "weekly_scoped", percent: 31, resets_at: "2026-10-11T11:59:59+00:00", scope: { model: { id: null, display_name: "Fable" } } },
          ],
          extra_usage: { is_enabled: false },
        }),
        { status: 200 },
      ),
    ));
    const windows = await fetchClaudeQuota("token");
    expect(windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Current session", 87],
      ["Current week (all models)", 21],
      ["Current week (Fable)", 31],
      ["Extra usage", null],
    ]);
  });
  it("does not repeat a model the fixed fields already cover", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 10 },
          seven_day_sonnet: { utilization: 40 },
          limits: [{ kind: "weekly_scoped", percent: 40, scope: { model: { display_name: "Sonnet" } } }],
        }),
        { status: 200 },
      ),
    ));
    const windows = await fetchClaudeQuota("token");
    expect(windows.map((window) => window.label)).toEqual(["Current session", "Current week (Sonnet only)"]);
  });
});

describe("describeClaudeQuotaHint", () => {
  it("prefers the folder-trust blocker over an OAuth status", () => {
    const hint = describeClaudeQuotaHint({
      oauthError: new ClaudeUsageApiError(401),
      cliError: new ClaudeCliUsageProbeError("trust_prompt", "Claude Code asked to trust the folder /srv before it would start.", "/srv"),
    });
    expect(hint).toContain("trust the folder /srv");
    expect(hint).not.toMatch(/sh -c|script -q|printf/);
  });
  it("explains an invalid login", () => {
    expect(describeClaudeQuotaHint({ oauthError: new ClaudeUsageApiError(401) })).toContain("Run `claude login`");
  });
  it("explains rate limiting", () => {
    expect(describeClaudeQuotaHint({ oauthError: new ClaudeUsageApiError(429) })).toContain("rate limiting");
  });
  it("explains a missing CLI", () => {
    expect(describeClaudeQuotaHint({ cliError: new ClaudeCliUsageProbeError("spawn_error", "x", "/srv") })).toContain("Install Claude Code");
  });
  it("passes through an error the usage panel itself reported", () => {
    const panelError = (() => {
      try {
        parseClaudeCliUsageText("Settings: Usage\nToken has expired\n");
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(panelError).toBeInstanceOf(ClaudeCliUsagePanelError);
    expect(describeClaudeQuotaHint({ cliError: panelError })).toBe("Claude CLI token expired. Run `claude login` to refresh.");
  });
  it("falls back to a retry hint for a slow CLI and to a login hint otherwise", () => {
    expect(describeClaudeQuotaHint({ cliError: new ClaudeCliUsageProbeError("prompt_timeout", "x", "/srv") })).toContain("Retry in a moment");
    expect(describeClaudeQuotaHint({})).toContain("Run `claude login`");
  });
});

describe("getQuotaWindows failure message", () => {
  it("tells the operator what to do and keeps the diagnostic detail in the server log", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockImplementation(async (file: string) => {
      if (file === "claude") {
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) };
      }
      return { stdout: JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }) };
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    mocks.spawn.mockImplementation(() => {
      const cli = new FakeClaudeCli();
      queueMicrotask(() => cli.print(TRUST_DIALOG));
      return cli.asChild();
    });

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      `Claude is logged in via claude.ai (max), but Paperclip could not read the subscription quota. Claude Code is waiting for you to trust the folder ${process.cwd()}. Open Claude Code in that folder once and accept the prompt, then retry.`,
    );
    expect(result.error).not.toMatch(/sh -c|Command failed|script -q|printf|sleep|\/usage/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      attempts: [
        "Anthropic OAuth usage: anthropic usage api returned 401",
        `Claude CLI /usage: Claude Code asked to trust the folder ${process.cwd()} before it would start.`,
      ],
    });

    // The same failure on the next poll stays out of the log.
    await getQuotaWindows();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
