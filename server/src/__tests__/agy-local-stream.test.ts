import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execute, parseAgyOutput, sessionCodec } from "@paperclipai/adapter-agy-local/server";
import { resolveNextSessionState } from "../services/heartbeat.js";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { parseAgyStdoutLine } from "@paperclipai/adapter-agy-local/ui";
import { printAgyStreamEvent } from "@paperclipai/adapter-agy-local/cli";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import { buildAgyRemoteSkillsCommand } from "../../../packages/adapters/agy-local/src/server/remote-skills.js";

const fixture = fs.readFileSync(new URL("./fixtures/agy-local/ok.ndjson", import.meta.url), "utf8");
const ts = "2026-09-30T12:00:00Z";

describe("AGY real stream regression", () => {
  it("extracts the captured response, conversation and run usage without duplicating deltas", () => {
    expect(parseAgyOutput(fixture, "")).toMatchObject({
      sessionId: "77777777-7777-4777-8777-777777777777", summary: "OK", errorMessage: null,
      usage: { inputTokens: 28174, outputTokens: 156, cachedInputTokens: 0 },
    });
    const entries = fixture.trim().split("\n").flatMap((line) => parseAgyStdoutLine(line, ts));
    expect(entries.find((entry) => entry.kind === "init")).toMatchObject({ sessionId: "77777777-7777-4777-8777-777777777777" });
    expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text).join("")).toBe("OK\n");
    expect(entries.find((entry) => entry.kind === "result")).toMatchObject({ text: "OK\n", inputTokens: 28174, outputTokens: 156 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      fixture.trim().split("\n").forEach((line) => printAgyStreamEvent(line, false));
      expect(log.mock.calls.flat().join("\n")).toContain("result: OK");
    } finally { log.mockRestore(); }
  });

  it("sums each step once and ignores cumulative session totals on resume", () => {
    const step = { event: "step_update", step_update: { conversation_id: "resumed", step_index: 4,
      step_type: "agent_response", state: "DONE", text_delta: "OK", usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 7 } } };
    const result = { event: "result", result: { conversation_id: "resumed", status: "SUCCESS", response: "OK",
      usage: { input_tokens: 9000, output_tokens: 300, cache_read_tokens: 700 } } };
    const stdout = [step, step, result].map((event) => JSON.stringify(event)).join("\n");
    expect(parseAgyOutput(stdout, "").usage).toEqual({ inputTokens: 10, outputTokens: 3, cachedInputTokens: 7 });
  });

  it("recovers partial text and usage when a stream ends before result", () => {
    const partial = fixture.trim().split("\n").slice(0, -1).join("\n");
    expect(parseAgyOutput(partial, "")).toMatchObject({ summary: "OK", usage: { inputTokens: 28174 } });
  });

  it("maps terminal errors and result-only streams across consumers", () => {
    const line = JSON.stringify({ event: "result", result: { conversation_id: "failed", status: "ERROR", error: "quota exceeded" } });
    expect(parseAgyOutput(line, "")).toMatchObject({ sessionId: "failed", errorMessage: "quota exceeded" });
    expect(parseAgyStdoutLine(line, ts)[0]).toMatchObject({ kind: "result", isError: true, errors: ["quota exceeded"] });
    const success = JSON.stringify({ event: "result", result: { conversation_id: "done", status: "SUCCESS", response: "OK", usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3 } } });
    expect(parseAgyOutput(success, "")).toMatchObject({ summary: "OK", usage: { cachedInputTokens: 3 } });
  });

  it("renders tool invocation, output and errors from step updates", () => {
    const line = JSON.stringify({ event: "step_update", step_update: { conversation_id: "tool-session", step_index: 2,
      state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo OK" }, output: "OK", error: { message: "failed" } } } });
    expect(parseAgyStdoutLine(line, ts)).toMatchObject([
      { kind: "tool_call", name: "run_command", input: { CommandLine: "echo OK" } },
      { kind: "tool_result", toolUseId: "tool-session:2", content: "OK", isError: true },
    ]);
  });

  it.each(["null", "[]", "42", "{broken", '{"event":"unknown"}'])("handles untrusted input %s", (line) => {
    expect(() => parseAgyOutput(line, "")).not.toThrow();
    expect(parseAgyStdoutLine(line, ts)[0]).toMatchObject({ kind: "stdout" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try { expect(() => printAgyStreamEvent(line, false)).not.toThrow(); } finally { log.mockRestore(); }
  });

  it("declares session resume with conservative compaction thresholds", () => {
    expect(getAdapterSessionManagement("agy_local")).toMatchObject({ supportsSessionResume: true,
      nativeContextManagement: "unknown", defaultSessionCompaction: { enabled: true, maxSessionRuns: 200, maxRawInputTokens: 2_000_000, maxSessionAgeHours: 72 } });
  });
});

describe("AGY stream execution and session recovery", () => {
  async function run(outputs: string[], sessionCwd = process.cwd()) {
    vi.spyOn(serverUtils, "readPaperclipRuntimeSkillEntries").mockResolvedValue([]);
    vi.spyOn(executionTarget, "ensureAdapterExecutionTargetCommandResolvable").mockResolvedValue(undefined);
    const processSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess");
    for (const stdout of outputs) processSpy.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" });
    const result = await execute({
      runId: "stream-run", agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
      runtime: { sessionId: "saved-session", sessionParams: { sessionId: "saved-session", cwd: sessionCwd }, sessionDisplayId: "saved-session" },
      config: { cwd: process.cwd(), command: process.execPath }, context: {}, onLog: vi.fn(),
    });
    return { result, args: processSpy.mock.calls.map((call) => call[3]) };
  }

  it("persists the conversation and usage from the real stream", async () => {
    try {
      const { result, args } = await run([fixture]);
      expect(args[0]).toContain("--conversation");
      expect(result).toMatchObject({ exitCode: 0, summary: "OK", sessionParams: { sessionId: "77777777-7777-4777-8777-777777777777" }, usage: { inputTokens: 28174 } });
    } finally { vi.restoreAllMocks(); }
  });

  it("retries a structured unknown-session result even when the process exits zero", async () => {
    try {
      const missing = JSON.stringify({ event: "result", result: { status: "ERROR", error: "unknown conversation saved-session" } });
      const { result, args } = await run([missing, fixture]);
      expect(args).toHaveLength(2);
      expect(args[1]).not.toContain("--conversation");
      expect(result).toMatchObject({ exitCode: 0, clearSession: false, sessionId: "77777777-7777-4777-8777-777777777777" });
    } finally { vi.restoreAllMocks(); }
  });

  it("does not relabel an incompatible saved session with the new cwd", async () => {
    try {
      const { result, args } = await run(["Done"], path.join(process.cwd(), "different-workspace"));
      expect(args[0]).not.toContain("--conversation");
      expect(result).toMatchObject({ sessionId: null, sessionParams: null, clearSession: true });
    } finally { vi.restoreAllMocks(); }
  });

  it("reports a terminal error as a failed run even with exit zero", async () => {
    try {
      const { result } = await run([JSON.stringify({ event: "result", result: { status: "ERROR", error: "quota exceeded" } })]);
      expect(result).toMatchObject({ exitCode: 1, errorMessage: "quota exceeded", errorCode: "agy_quota_exhausted" });
    } finally { vi.restoreAllMocks(); }
  });
});

describe("AGY remote skill ownership", () => {
  it("preserves external and colliding skills, updates owned links and removes stale owned links", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-agy-skills-test-"));
    const unixPath = (value: string) => process.platform === "win32" ? value.replace(os.tmpdir(), "/tmp").replace(/\\/g, "/") : value;
    const home = unixPath(path.join(root, "home 'quoted'"));
    const source = unixPath(path.join(root, "source"));
    const skills = home + "/.gemini/skills";
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    // All mutation targets are contained in the freshly created temp directory.
    const script = [
      `mkdir -p "${source}/owned" "${source}/external" "${skills}/external" "${skills}/unrelated"`,
      `printf original > "${skills}/external/SKILL.md"`,
      `printf first > "${source}/owned/SKILL.md"`,
      buildAgyRemoteSkillsCommand(skills, source, ["owned", "external"]),
      `test "$(cat \"${skills}/external/SKILL.md\")" = original`,
      `test -d "${skills}/unrelated"`,
      `test "$(cat \"${skills}/owned/SKILL.md\")" = first`,
      `printf updated > "${source}/owned/SKILL.md"`,
      buildAgyRemoteSkillsCommand(skills, source, ["owned"]),
      `test "$(cat \"${skills}/owned/SKILL.md\")" = updated`,
      buildAgyRemoteSkillsCommand(skills, source, []),
      `test ! -L "${skills}/owned"`,
      `test "$(cat \"${skills}/external/SKILL.md\")" = original`,
    ].join("\n");
    try { execFileSync(bash, ["-c", script], { env: { ...process.env, MSYS: "winsymlinks:nativestrict" }, stdio: "pipe" }); }
    catch (error) { throw new Error(String((error as { stderr: Buffer }).stderr).slice(-3500)); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("aborts and preserves external destinations when only skills root is a symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-agy-skills-test-"));
    const unixPath = (value: string) => process.platform === "win32" ? value.replace(os.tmpdir(), "/tmp").replace(/\\/g, "/") : value;
    const home = unixPath(path.join(root, "home"));
    const realSkills = unixPath(path.join(root, "real_skills"));
    const source = unixPath(path.join(root, "source"));
    const skills = home + "/.gemini/skills";
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const script = [
      `mkdir -p "${home}/.gemini" "${realSkills}/colliding" "${source}/colliding"`,
      `printf 'external-original' > "${realSkills}/colliding/SKILL.md"`,
      `printf 'source-replacement' > "${source}/colliding/SKILL.md"`,
      `ln -s "${realSkills}" "${skills}"`,
      buildAgyRemoteSkillsCommand(skills, source, ["colliding"]),
    ].join("\n");
    let failed = false;
    let stderr = "";
    try {
      execFileSync(bash, ["-c", script], { env: { ...process.env, MSYS: "winsymlinks:nativestrict" }, stdio: "pipe" });
    } catch (error) {
      failed = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    } finally {
      expect(failed).toBe(true);
      expect(stderr).toContain("Refusing symlinked skills root");
      const realContent = fs.readFileSync(path.join(root, "real_skills", "colliding", "SKILL.md"), "utf8");
      expect(realContent).toBe("external-original");
      expect(fs.existsSync(path.join(root, "home", ".gemini", ".paperclip-agy-skills"))).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts and preserves external destinations when only managed root is a symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-agy-skills-test-"));
    const unixPath = (value: string) => process.platform === "win32" ? value.replace(os.tmpdir(), "/tmp").replace(/\\/g, "/") : value;
    const home = unixPath(path.join(root, "home"));
    const realManaged = unixPath(path.join(root, "real_managed"));
    const source = unixPath(path.join(root, "source"));
    const skills = home + "/.gemini/skills";
    const managed = home + "/.gemini/.paperclip-agy-skills";
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const script = [
      `mkdir -p "${home}/.gemini" "${skills}/existing" "${realManaged}/secret" "${source}/owned"`,
      `printf 'external-secret' > "${realManaged}/secret/secret.txt"`,
      `printf 'user-skill' > "${skills}/existing/SKILL.md"`,
      `printf 'source-skill' > "${source}/owned/SKILL.md"`,
      `ln -s "${realManaged}" "${managed}"`,
      buildAgyRemoteSkillsCommand(skills, source, ["owned"]),
    ].join("\n");
    let failed = false;
    let stderr = "";
    try {
      execFileSync(bash, ["-c", script], { env: { ...process.env, MSYS: "winsymlinks:nativestrict" }, stdio: "pipe" });
    } catch (error) {
      failed = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    } finally {
      expect(failed).toBe(true);
      expect(stderr).toContain("Refusing symlinked skills root");
      const secretContent = fs.readFileSync(path.join(root, "real_managed", "secret", "secret.txt"), "utf8");
      expect(secretContent).toBe("external-secret");
      const userSkill = fs.readFileSync(path.join(root, "home", ".gemini", "skills", "existing", "SKILL.md"), "utf8");
      expect(userSkill).toBe("user-skill");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts and preserves external destinations when both roots are symlinks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-agy-skills-test-"));
    const unixPath = (value: string) => process.platform === "win32" ? value.replace(os.tmpdir(), "/tmp").replace(/\\/g, "/") : value;
    const home = unixPath(path.join(root, "home"));
    const realSkills = unixPath(path.join(root, "real_skills"));
    const realManaged = unixPath(path.join(root, "real_managed"));
    const source = unixPath(path.join(root, "source"));
    const skills = home + "/.gemini/skills";
    const managed = home + "/.gemini/.paperclip-agy-skills";
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const script = [
      `mkdir -p "${home}/.gemini" "${realSkills}/colliding" "${realManaged}/canary" "${source}/colliding"`,
      `printf 'real-skills-colliding' > "${realSkills}/colliding/SKILL.md"`,
      `printf 'canary-data' > "${realManaged}/canary/canary.txt"`,
      `printf 'source-data' > "${source}/colliding/SKILL.md"`,
      `ln -s "${realSkills}" "${skills}"`,
      `ln -s "${realManaged}" "${managed}"`,
      buildAgyRemoteSkillsCommand(skills, source, ["colliding"]),
    ].join("\n");
    let failed = false;
    let stderr = "";
    try {
      execFileSync(bash, ["-c", script], { env: { ...process.env, MSYS: "winsymlinks:nativestrict" }, stdio: "pipe" });
    } catch (error) {
      failed = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    } finally {
      expect(failed).toBe(true);
      expect(stderr).toContain("Refusing symlinked skills root");
      const collidingContent = fs.readFileSync(path.join(root, "real_skills", "colliding", "SKILL.md"), "utf8");
      expect(collidingContent).toBe("real-skills-colliding");
      const canaryContent = fs.readFileSync(path.join(root, "real_managed", "canary", "canary.txt"), "utf8");
      expect(canaryContent).toBe("canary-data");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("integrally preserves files, directories, colliding skills and links in external destinations after rejection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-agy-skills-test-"));
    const unixPath = (value: string) => process.platform === "win32" ? value.replace(os.tmpdir(), "/tmp").replace(/\\/g, "/") : value;
    const home = unixPath(path.join(root, "home"));
    const realSkills = unixPath(path.join(root, "real_skills"));
    const source = unixPath(path.join(root, "source"));
    const skills = home + "/.gemini/skills";
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const script = [
      `mkdir -p "${home}/.gemini" "${realSkills}/ext_dir/sub" "${source}/ext_dir"`,
      `printf 'nested-file' > "${realSkills}/ext_dir/sub/nested.txt"`,
      `ln -s "${realSkills}/ext_dir/sub/nested.txt" "${realSkills}/link_to_file"`,
      `printf 'danger' > "${source}/ext_dir/pwn.txt"`,
      `ln -s "${realSkills}" "${skills}"`,
      buildAgyRemoteSkillsCommand(skills, source, ["ext_dir"]),
    ].join("\n");
    let failed = false;
    try {
      execFileSync(bash, ["-c", script], { env: { ...process.env, MSYS: "winsymlinks:nativestrict" }, stdio: "pipe" });
    } catch {
      failed = true;
    } finally {
      expect(failed).toBe(true);
      expect(fs.readFileSync(path.join(root, "real_skills", "ext_dir", "sub", "nested.txt"), "utf8")).toBe("nested-file");
      expect(fs.existsSync(path.join(root, "real_skills", "ext_dir", "pwn.txt"))).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts when skillsHome has a trailing slash and targets a symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-agy-skills-test-"));
    const unixPath = (value: string) => process.platform === "win32" ? value.replace(os.tmpdir(), "/tmp").replace(/\\/g, "/") : value;
    const home = unixPath(path.join(root, "home"));
    const realSkills = unixPath(path.join(root, "real_skills"));
    const source = unixPath(path.join(root, "source"));
    const skills = home + "/.gemini/skills/";
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const script = [
      `mkdir -p "${home}/.gemini" "${realSkills}" "${source}/owned"`,
      `ln -s "${realSkills}" "${home}/.gemini/skills"`,
      buildAgyRemoteSkillsCommand(skills, source, ["owned"]),
    ].join("\n");
    let failed = false;
    let stderr = "";
    try {
      execFileSync(bash, ["-c", script], { env: { ...process.env, MSYS: "winsymlinks:nativestrict" }, stdio: "pipe" });
    } catch (error) {
      failed = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    } finally {
      expect(failed).toBe(true);
      expect(stderr).toContain("Refusing symlinked skills root");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in runtime skill names", () => {
    expect(() => buildAgyRemoteSkillsCommand("/home/user/.gemini/skills", "/assets", ["../external"])).toThrow("Invalid AGY skill name");
  });
});

describe("AGY resumed session token accounting and heartbeat normalization", () => {
  function simulateHeartbeatNormalization(input: {
    sessionId: string | null;
    rawUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
    usageBasis?: "per_run" | "session_cumulative" | null;
    previousRawUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
  }) {
    const { sessionId, rawUsage, usageBasis, previousRawUsage } = input;
    if (!sessionId || !rawUsage || usageBasis === "per_run") {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null,
        derivedFromSessionTotals: false,
      };
    }
    const inputTokens =
      rawUsage.inputTokens >= (previousRawUsage?.inputTokens ?? 0)
        ? rawUsage.inputTokens - (previousRawUsage?.inputTokens ?? 0)
        : rawUsage.inputTokens;
    const cachedInputTokens =
      (rawUsage.cachedInputTokens ?? 0) >= (previousRawUsage?.cachedInputTokens ?? 0)
        ? (rawUsage.cachedInputTokens ?? 0) - (previousRawUsage?.cachedInputTokens ?? 0)
        : rawUsage.cachedInputTokens ?? 0;
    const outputTokens =
      rawUsage.outputTokens >= (previousRawUsage?.outputTokens ?? 0)
        ? rawUsage.outputTokens - (previousRawUsage?.outputTokens ?? 0)
        : rawUsage.outputTokens;
    return {
      normalizedUsage: { inputTokens, cachedInputTokens, outputTokens },
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function executeTurn(params: {
    runId: string;
    sessionId?: string | null;
    sessionParams?: Record<string, unknown> | null;
    stdout: string;
  }) {
    vi.spyOn(serverUtils, "readPaperclipRuntimeSkillEntries").mockResolvedValue([]);
    vi.spyOn(executionTarget, "ensureAdapterExecutionTargetCommandResolvable").mockResolvedValue(undefined);
    const processSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess");
    processSpy.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: params.stdout, stderr: "" });
    return execute({
      runId: params.runId,
      agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
      runtime: {
        sessionId: params.sessionId ?? null,
        sessionParams: params.sessionParams ?? null,
        sessionDisplayId: params.sessionId ?? null,
      },
      config: { cwd: process.cwd(), command: process.execPath },
      context: {},
      onLog: vi.fn(),
    });
  }

  it("declares per_run usage for consecutive runs with step usage so heartbeat does not undercount", async () => {
    try {
      const turn1Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-1", init: {} }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "sess-1",
            step_index: 1,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "Turn 1",
            usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 50 },
          },
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "sess-1",
            status: "SUCCESS",
            response: "Turn 1",
            usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 50 },
          },
        }),
      ].join("\n");

      const res1 = await executeTurn({ runId: "run-1", stdout: turn1Output });
      expect(res1.usage).toEqual({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 50 });
      expect(res1.usageBasis).toBe("per_run");
      expect(res1.sessionParams).toMatchObject({
        sessionId: "sess-1",
        cumulativeUsage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 50 },
      });

      const hb1 = simulateHeartbeatNormalization({
        sessionId: "sess-1",
        rawUsage: res1.usage,
        usageBasis: res1.usageBasis,
        previousRawUsage: null,
      });
      expect(hb1.normalizedUsage).toEqual({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 50 });
      expect(hb1.derivedFromSessionTotals).toBe(false);

      // Turn 2 in the same resumed session with 1200 tokens of step usage
      const turn2Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-1", init: {} }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "sess-1",
            step_index: 2,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "Turn 2",
            usage: { input_tokens: 1200, output_tokens: 120, cache_read_tokens: 60 },
          },
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "sess-1",
            status: "SUCCESS",
            response: "Turn 2",
            usage: { input_tokens: 2200, output_tokens: 220, cache_read_tokens: 110 },
          },
        }),
      ].join("\n");

      const res2 = await executeTurn({
        runId: "run-2",
        sessionId: "sess-1",
        sessionParams: res1.sessionParams,
        stdout: turn2Output,
      });
      expect(res2.usage).toEqual({ inputTokens: 1200, outputTokens: 120, cachedInputTokens: 60 });
      expect(res2.usageBasis).toBe("per_run");
      expect(res2.sessionParams).toMatchObject({
        sessionId: "sess-1",
        cumulativeUsage: { inputTokens: 2200, outputTokens: 220, cachedInputTokens: 110 },
      });

      // Heartbeat normalization must NOT subtract previous run's 1000 tokens to get 200:
      const hb2 = simulateHeartbeatNormalization({
        sessionId: "sess-1",
        rawUsage: res2.usage,
        usageBasis: res2.usageBasis,
        previousRawUsage: res1.usage,
      });
      expect(hb2.normalizedUsage).toEqual({ inputTokens: 1200, outputTokens: 120, cachedInputTokens: 60 });
      expect(hb2.derivedFromSessionTotals).toBe(false);

      // Total session tokens across runs is 2200, not 1200 or 200:
      const sessionTotal = hb1.normalizedUsage!.inputTokens + hb2.normalizedUsage!.inputTokens;
      expect(sessionTotal).toBe(2200);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("handles absence of step usage by computing per_run delta from sessionParams or falling back to session_cumulative", async () => {
    try {
      // Turn 1: Fresh session, absence of step usage, result.usage only
      const turn1Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-no-steps", init: {} }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "sess-no-steps",
            status: "SUCCESS",
            response: "Turn 1",
            usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 50 },
          },
        }),
      ].join("\n");

      const res1 = await executeTurn({ runId: "run-1", stdout: turn1Output });
      expect(res1.usage).toEqual({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 50 });
      expect(res1.usageBasis).toBe("per_run");
      expect(res1.sessionParams).toMatchObject({
        sessionId: "sess-no-steps",
        cumulativeUsage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 50 },
      });

      // Turn 2: Resumed session, absence of step usage, cumulative result.usage = 2200
      const turn2Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-no-steps", init: {} }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "sess-no-steps",
            status: "SUCCESS",
            response: "Turn 2",
            usage: { input_tokens: 2200, output_tokens: 220, cache_read_tokens: 110 },
          },
        }),
      ].join("\n");

      const res2 = await executeTurn({
        runId: "run-2",
        sessionId: "sess-no-steps",
        sessionParams: res1.sessionParams,
        stdout: turn2Output,
      });
      // Computed delta: 2200 - 1000 = 1200
      expect(res2.usage).toEqual({ inputTokens: 1200, outputTokens: 120, cachedInputTokens: 60 });
      expect(res2.usageBasis).toBe("per_run");
      expect(res2.sessionParams).toMatchObject({
        sessionId: "sess-no-steps",
        cumulativeUsage: { inputTokens: 2200, outputTokens: 220, cachedInputTokens: 110 },
      });

      // Turn 3: Resumed session WITHOUT prior sessionParams.cumulativeUsage
      const res3 = await executeTurn({
        runId: "run-3",
        sessionId: "sess-no-steps",
        sessionParams: null,
        stdout: turn2Output,
      });
      // Without prior knowledge of cumulativeUsage, declare session_cumulative rather than per_run
      expect(res3.usage).toEqual({ inputTokens: 2200, outputTokens: 220, cachedInputTokens: 110 });
      expect(res3.usageBasis).toBe("session_cumulative");

      // Heartbeat derives delta from previous run's raw usage (1000):
      const hb3 = simulateHeartbeatNormalization({
        sessionId: "sess-no-steps",
        rawUsage: res3.usage,
        usageBasis: res3.usageBasis,
        previousRawUsage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 50 },
      });
      expect(hb3.derivedFromSessionTotals).toBe(true);
      expect(hb3.normalizedUsage).toEqual({ inputTokens: 1200, outputTokens: 120, cachedInputTokens: 60 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("alternates between step usage and cumulative fallback without undercounting or double counting", async () => {
    try {
      // Turn 1: Step usage = 1000
      const turn1Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-alt", init: {} }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "sess-alt",
            step_index: 1,
            state: "DONE",
            step_type: "agent_response",
            usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0 },
          },
        }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: "sess-alt", status: "SUCCESS", response: "1", usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0 } },
        }),
      ].join("\n");
      const res1 = await executeTurn({ runId: "r-1", stdout: turn1Output });
      expect(res1.usage.inputTokens).toBe(1000);
      expect(res1.usageBasis).toBe("per_run");

      // Turn 2: Fallback cumulative (no step usage), cumulative result = 2200
      const turn2Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-alt", init: {} }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: "sess-alt", status: "SUCCESS", response: "2", usage: { input_tokens: 2200, output_tokens: 200, cache_read_tokens: 0 } },
        }),
      ].join("\n");
      const res2 = await executeTurn({ runId: "r-2", sessionId: "sess-alt", sessionParams: res1.sessionParams, stdout: turn2Output });
      expect(res2.usage.inputTokens).toBe(1200); // 2200 - 1000
      expect(res2.usageBasis).toBe("per_run");

      // Turn 3: Step usage = 500, cumulative result = 2700
      const turn3Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-alt", init: {} }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "sess-alt",
            step_index: 3,
            state: "DONE",
            step_type: "agent_response",
            usage: { input_tokens: 500, output_tokens: 50, cache_read_tokens: 0 },
          },
        }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: "sess-alt", status: "SUCCESS", response: "3", usage: { input_tokens: 2700, output_tokens: 250, cache_read_tokens: 0 } },
        }),
      ].join("\n");
      const res3 = await executeTurn({ runId: "r-3", sessionId: "sess-alt", sessionParams: res2.sessionParams, stdout: turn3Output });
      expect(res3.usage.inputTokens).toBe(500);
      expect(res3.usageBasis).toBe("per_run");

      // Turn 4: Fallback cumulative (no step usage), cumulative result = 3000
      const turn4Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-alt", init: {} }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: "sess-alt", status: "SUCCESS", response: "4", usage: { input_tokens: 3000, output_tokens: 300, cache_read_tokens: 0 } },
        }),
      ].join("\n");
      const res4 = await executeTurn({ runId: "r-4", sessionId: "sess-alt", sessionParams: res3.sessionParams, stdout: turn4Output });
      expect(res4.usage.inputTokens).toBe(300); // 3000 - 2700
      expect(res4.usageBasis).toBe("per_run");

      // Verify total across all 4 runs equals 3000:
      const totalInputTokens = res1.usage.inputTokens + res2.usage.inputTokens + res3.usage.inputTokens + res4.usage.inputTokens;
      expect(totalInputTokens).toBe(3000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not declare usageBasis when result event lacks usage statistics", () => {
    const stdout = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "sess-no-stats",
        status: "SUCCESS",
        response: "Hello world without stats",
      },
    });
    const parsed = parseAgyOutput(stdout, "");
    expect(parsed.usageBasis).toBeNull();
    expect(parsed.resultUsage).toBeNull();
    expect(parsed.hasStepUsage).toBe(false);
  });

  it("does not subtract previous session cumulative usage when AGY returns a new session ID", async () => {
    try {
      // Turn 1 on sess-old has 1000 tokens
      const turn1Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-old", init: {} }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: "sess-old", status: "SUCCESS", response: "Old", usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0 } },
        }),
      ].join("\n");
      const res1 = await executeTurn({ runId: "r-old", stdout: turn1Output });
      expect(res1.sessionId).toBe("sess-old");
      expect(res1.usage.inputTokens).toBe(1000);
      expect(res1.usageBasis).toBe("per_run");

      // Turn 2 is attempted on sess-old, but AGY CLI starts a brand new conversation sess-new with 500 tokens
      const turn2Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-new", init: {} }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: "sess-new", status: "SUCCESS", response: "New", usage: { input_tokens: 500, output_tokens: 50, cache_read_tokens: 0 } },
        }),
      ].join("\n");
      const res2 = await executeTurn({
        runId: "r-new",
        sessionId: "sess-old",
        sessionParams: res1.sessionParams,
        stdout: turn2Output,
      });

      expect(res2.sessionId).toBe("sess-new");
      // Must NOT subtract sess-old's 1000 tokens to get 0:
      expect(res2.usage.inputTokens).toBe(500);
      expect(res2.usageBasis).toBe("per_run");
      expect(res2.sessionParams).toMatchObject({
        sessionId: "sess-new",
        cumulativeUsage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0 },
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves cumulativeUsage across persistence via resolveNextSessionState so third run computes delta correctly", async () => {
    try {
      // Turn 1: 1,000 tokens
      const turn1Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-persist-test", init: {} }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "sess-persist-test",
            status: "SUCCESS",
            response: "Turn 1",
            usage: { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 },
          },
        }),
      ].join("\n");

      const res1 = await executeTurn({ runId: "r-1", stdout: turn1Output });
      expect(res1.usage.inputTokens).toBe(1000);
      expect(res1.usageBasis).toBe("per_run");

      // Pass through resolveNextSessionState (which serializes and deserializes via sessionCodec)
      const nextSession1 = resolveNextSessionState({
        adapterType: "agy_local",
        codec: sessionCodec,
        adapterResult: res1,
        outcome: "succeeded",
        previousParams: null,
        previousDisplayId: null,
        previousLegacySessionId: null,
      });
      expect(nextSession1.params?.cumulativeUsage).toEqual({
        inputTokens: 1000,
        outputTokens: 0,
        cachedInputTokens: 0,
      });

      // Turn 2: Cumulative total = 1,200 tokens (delta = 200)
      const turn2Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-persist-test", init: {} }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "sess-persist-test",
            status: "SUCCESS",
            response: "Turn 2",
            usage: { input_tokens: 1200, output_tokens: 0, cache_read_tokens: 0 },
          },
        }),
      ].join("\n");

      // Simulate DB jsonb persistence roundtrip (serializes as JSON, then deserialized by sessionCodec for next run)
      const persistedParams1 = sessionCodec.deserialize(JSON.parse(JSON.stringify(nextSession1.params)));

      const res2 = await executeTurn({
        runId: "r-2",
        sessionId: "sess-persist-test",
        sessionParams: persistedParams1,
        stdout: turn2Output,
      });
      expect(res2.usage.inputTokens).toBe(200);
      expect(res2.usageBasis).toBe("per_run");

      const nextSession2 = resolveNextSessionState({
        adapterType: "agy_local",
        codec: sessionCodec,
        adapterResult: res2,
        outcome: "succeeded",
        previousParams: nextSession1.params,
        previousDisplayId: nextSession1.displayId,
        previousLegacySessionId: nextSession1.legacySessionId,
      });
      expect(nextSession2.params?.cumulativeUsage).toEqual({
        inputTokens: 1200,
        outputTokens: 0,
        cachedInputTokens: 0,
      });

      // Simulate DB jsonb persistence roundtrip for turn 2
      const persistedParams2 = sessionCodec.deserialize(JSON.parse(JSON.stringify(nextSession2.params)));

      // Turn 3: 300 additional tokens (cumulative total = 1,500 tokens)
      const turn3Output = [
        JSON.stringify({ event: "init", conversation_id: "sess-persist-test", init: {} }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "sess-persist-test",
            status: "SUCCESS",
            response: "Turn 3",
            usage: { input_tokens: 1500, output_tokens: 0, cache_read_tokens: 0 },
          },
        }),
      ].join("\n");

      const res3 = await executeTurn({
        runId: "r-3",
        sessionId: "sess-persist-test",
        sessionParams: persistedParams2,
        stdout: turn3Output,
      });
      // Before fix: sessionCodec discarded cumulativeUsage, so Turn 3 had no previousCumulativeUsage,
      // and counted all 1,500 tokens as session_cumulative.
      // With fix: 1500 - 1200 = 300 tokens, basis per_run!
      expect(res3.usage.inputTokens).toBe(300);
      expect(res3.usageBasis).toBe("per_run");
      expect(res3.sessionParams).toMatchObject({
        sessionId: "sess-persist-test",
        cumulativeUsage: { inputTokens: 1500, outputTokens: 0, cachedInputTokens: 0 },
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

