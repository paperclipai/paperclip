import { execFileSync, spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const {
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  runForbiddenTokenCheck,
} = await import("../../../scripts/check-forbidden-tokens.mjs");

function completedScan(code: number | null, chunks: string[] = [], signal: string | null = null) {
  const child = new EventEmitter();
  const stdout = Readable.from(chunks);
  stdout.once("end", () => child.emit("close", code, signal));
  return Object.assign(child, { stdout, kill: vi.fn() });
}

function captureOutput() {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { output, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("forbidden token check", () => {
  it("derives username tokens without relying on whoami", () => {
    const tokens = resolveDynamicForbiddenTokens(
      { USER: "paperclip", LOGNAME: "paperclip", USERNAME: "pc" },
      {
        userInfo: () => ({ username: "paperclip" }),
      },
    );

    expect(tokens).toEqual(["paperclip", "pc"]);
  });

  it("falls back cleanly when user resolution fails", () => {
    const tokens = resolveDynamicForbiddenTokens(
      {},
      {
        userInfo: () => {
          throw new Error("missing user");
        },
      },
    );

    expect(tokens).toEqual([]);
  });

  it("merges dynamic and file-based forbidden tokens", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tokensFile = path.join(os.tmpdir(), `forbidden-tokens-${Date.now()}.txt`);
    fs.writeFileSync(tokensFile, "# comment\npaperclip\ncustom-token\n");

    try {
      const tokens = resolveForbiddenTokens(tokensFile, { USER: "paperclip" }, {
        userInfo: () => ({ username: "paperclip" }),
      });

      expect(tokens).toEqual(["paperclip", "custom-token"]);
    } finally {
      fs.unlinkSync(tokensFile);
    }
  });

  it("reports streamed matches without logging the searched token", async () => {
    const spawn = vi.fn()
      .mockImplementationOnce(() => completedScan(0, ["server/file.ts:1:found\n"]))
      .mockImplementationOnce(() => completedScan(1));
    const { output, text } = captureOutput();
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = await runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip", "custom-token"],
      spawn,
      output,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(text()).toBe("server/file.ts:1:found\n");
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("ERROR: Forbidden tokens found in tracked files:\n");
    expect(error).toHaveBeenCalledWith("\nBuild blocked. Remove the forbidden token(s) before publishing.");
    expect(JSON.stringify(error.mock.calls)).not.toContain("custom-token");
  });

  it("passes only normal no-match exits and leaves an empty list unchanged", async () => {
    const spawn = vi.fn(() => completedScan(1));
    const { output } = captureOutput();
    const log = vi.fn();
    const error = vi.fn();

    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["missing"], spawn, output, log, error })).toBe(0);
    expect(log).toHaveBeenCalledWith("  ✓  No forbidden tokens found.");
    expect(error).not.toHaveBeenCalled();
    spawn.mockClear();
    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: [], spawn, output, log, error })).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    [2, null],
    [128, null],
    [null, "SIGTERM"],
    [1, "SIGTERM"],
    [null, null],
  ] as const)("blocks unexpected exit %s or signal %s", async (code, signal) => {
    const spawn = vi.fn(() => completedScan(code, [], signal));
    const { output } = captureOutput();
    const log = vi.fn();
    const error = vi.fn();

    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["missing"], spawn, output, log, error })).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Forbidden token scan failed"));
    expect(error).toHaveBeenCalledWith("\nBuild blocked. Forbidden token scan did not complete successfully.");
  });

  it("keeps a failure sticky across later no-match results", async () => {
    const spawn = vi.fn()
      .mockImplementationOnce(() => completedScan(null, [], "SIGTERM"))
      .mockImplementationOnce(() => completedScan(1));
    const { output } = captureOutput();
    const log = vi.fn();
    const error = vi.fn();

    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["first", "second"], spawn, output, log, error })).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it("blocks a match exit even if stdout is empty", async () => {
    const spawn = vi.fn(() => completedScan(0));
    const { output } = captureOutput();
    const log = vi.fn();

    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["present"], spawn, output, log, error: vi.fn() })).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("blocks an actually signalled subprocess", async () => {
    const spawn = (_command: string, _args: string[], options: object) => spawnChild(
      process.execPath,
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      { ...options, env: {} },
    );
    const { output } = captureOutput();
    const log = vi.fn();
    const error = vi.fn();

    expect(await runForbiddenTokenCheck({ repoRoot: process.cwd(), tokens: ["missing"], spawn, output, log, error })).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("SIGTERM"));
  });

  it.each(["ENOENT", "ENOBUFS"])("blocks a spawn error %s without logging its message", async (code) => {
    const spawn = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => child.emit("error", Object.assign(new Error("searched-token"), { code })));
      return child;
    });
    const { output } = captureOutput();
    const log = vi.fn();
    const error = vi.fn();

    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["searched-token"], spawn, output, log, error })).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).toContain(code);
    expect(JSON.stringify(error.mock.calls)).not.toContain("searched-token");
  });

  it("blocks a synchronous spawn exception", async () => {
    const spawn = vi.fn(() => { throw Object.assign(new Error("spawn failed"), { code: "ENOENT" }); });
    const log = vi.fn();
    const error = vi.fn();

    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["missing"], spawn, log, error })).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
  });

  it("blocks a stdout stream failure", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.stdout.destroy(Object.assign(new Error("stream failed"), { code: "ENOBUFS" })));
      return child;
    });
    const { output } = captureOutput();
    const log = vi.fn();
    const error = vi.fn();

    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["missing"], spawn, output, log, error })).toBe(1);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ENOBUFS"));
  });

  it("passes the token as inert argv and preserves grep scope", async () => {
    const token = "$(not-a-command)";
    const spawn = vi.fn(() => completedScan(1));
    const { output } = captureOutput();

    expect(await runForbiddenTokenCheck({ repoRoot: "/repo", tokens: [token], spawn, output, log: vi.fn() })).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["grep", "-in", "--no-color", "--", token, "--", ":!pnpm-lock.yaml", ":!.git"],
      { cwd: "/repo", stdio: ["ignore", "pipe", "ignore"] },
    );
  });

  it("streams real git matches beyond the old buffer limit and distinguishes no-match from failure", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "forbidden-token-git-"));
    const token = "synthetic-forbidden-marker";
    const lines = Array.from({ length: 14000 }, () => `${token}${"x".repeat(100)}`);
    const expected = lines.map((line, i) => `fixture.txt:${i + 1}:${line}\n`).join("");
    const env = {
      PATH: process.env.PATH,
      HOME: repoRoot,
      TMPDIR: process.env.TMPDIR,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(repoRoot, "empty-config"),
    };
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    const spawn = (command: string, args: string[], options: object) => spawnChild(command, args, { ...options, env });

    try {
      execFileSync("git", ["init", "--quiet", repoRoot], { env });
      writeFileSync(join(repoRoot, "fixture.txt"), `${lines.join("\n")}\n`);
      execFileSync("git", ["add", "fixture.txt"], { cwd: repoRoot, env });
      const hash = createHash("sha256");
      let bytes = 0;
      const output = new Writable({
        highWaterMark: 1024,
        write(chunk, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          setImmediate(callback);
        },
      });
      const log = vi.fn();
      const error = vi.fn();

      expect(await runForbiddenTokenCheck({ repoRoot, tokens: [token], spawn, output, log, error })).toBe(1);
      await new Promise<void>((resolve, reject) => output.end((err?: Error | null) => err ? reject(err) : resolve()));
      expect(bytes).toBe(Buffer.byteLength(expected));
      expect(bytes).toBeGreaterThan(1024 * 1024);
      expect(hash.digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
      expect(log).not.toHaveBeenCalled();

      const quiet = captureOutput();
      expect(await runForbiddenTokenCheck({ repoRoot, tokens: ["absent-marker"], spawn, output: quiet.output, log, error })).toBe(0);
      expect(log).toHaveBeenCalledWith("  ✓  No forbidden tokens found.");
      log.mockClear();
      expect(await runForbiddenTokenCheck({ repoRoot, tokens: ["["], spawn, output: quiet.output, log, error })).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Forbidden token scan failed"));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
