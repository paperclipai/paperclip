import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as serverUtils from "./server-utils.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";

type ControlPipe = "stdout" | "stderr";
type ControlCallback = (stream: ControlPipe, records: string) => Promise<void>;

const assistant = (content: string) => JSON.stringify({ role: "assistant", content });

function baseOptions(env: Record<string, string> = {}) {
  return {
    cwd: process.cwd(),
    env,
    timeoutSec: 5,
    graceSec: 1,
    onLog: async () => {},
  };
}

// Synchronous dual-write child: one newline-terminated record plus one
// unterminated EOF record per pipe, then exit. No secrets, so sanitized
// control output must equal the literal bytes written.
const DUAL_PIPE_SCRIPT = `
const fs = require('node:fs');
fs.writeSync(1, '{"role":"assistant","content":"stdout-first"}\\n');
fs.writeSync(1, '{"role":"assistant","content":"stdout-last"}');
fs.writeSync(2, '{"role":"assistant","content":"stderr-first"}\\n');
fs.writeSync(2, '{"role":"assistant","content":"stderr-last"}');
`;

describe("execution-target control-output forwarding (real local child)", () => {
  it("forwards a complete newline record plus unterminated EOF once in order on stdout", async () => {
    const seen: string[] = [];
    const stdoutOnly: ControlCallback = async (stream, records) => {
      if (stream === "stdout") seen.push(records);
    };
    const result = await runAdapterExecutionTargetProcess(
      randomUUID(),
      null,
      process.execPath,
      ["-e", DUAL_PIPE_SCRIPT],
      { ...baseOptions(), onControlOutput: stdoutOnly },
    );
    expect(result.exitCode).toBe(0);
    const stdoutControls = seen.join("");
    expect(stdoutControls).toBe(
      `${assistant("stdout-first")}\n${assistant("stdout-last")}`,
    );
    expect(stdoutControls.split("\n").map((line) => JSON.parse(line))).toEqual([
      JSON.parse(assistant("stdout-first")),
      JSON.parse(assistant("stdout-last")),
    ]);
  });

  it("forwards a complete newline record plus unterminated EOF once in order on stderr", async () => {
    const seen: string[] = [];
    const onControlOutput: ControlCallback = async (stream, records) => {
      expect(stream).toBe("stderr");
      seen.push(records);
    };
    // Filter to stderr only: the wrapper still receives stdout controls, but
    // this case asserts the stderr side once/ordered in isolation.
    const stderrOnly: ControlCallback = async (stream, records) => {
      if (stream === "stderr") await onControlOutput(stream, records);
    };
    const result = await runAdapterExecutionTargetProcess(
      randomUUID(),
      { kind: "local" },
      process.execPath,
      ["-e", DUAL_PIPE_SCRIPT],
      { ...baseOptions(), onControlOutput: stderrOnly },
    );
    expect(result.exitCode).toBe(0);
    const stderrControls = seen.join("");
    expect(stderrControls).toBe(
      `${assistant("stderr-first")}\n${assistant("stderr-last")}`,
    );
    expect(stderrControls.split("\n").map((line) => JSON.parse(line))).toEqual([
      JSON.parse(assistant("stderr-first")),
      JSON.parse(assistant("stderr-last")),
    ]);
  });

  it("keeps both pipes independent and ordered when both emit complete plus EOF records", async () => {
    const byPipe: Record<ControlPipe, string[]> = { stdout: [], stderr: [] };
    const onControlOutput: ControlCallback = async (stream, records) => {
      byPipe[stream].push(records);
    };
    const result = await runAdapterExecutionTargetProcess(
      randomUUID(),
      null,
      process.execPath,
      ["-e", DUAL_PIPE_SCRIPT],
      { ...baseOptions(), onControlOutput },
    );
    expect(result.exitCode).toBe(0);
    expect(byPipe.stdout.join("")).toBe(
      `${assistant("stdout-first")}\n${assistant("stdout-last")}`,
    );
    expect(byPipe.stderr.join("")).toBe(
      `${assistant("stderr-first")}\n${assistant("stderr-last")}`,
    );
    // No cross-pipe mixing: every stdout batch parses as stdout records only.
    expect(
      byPipe.stdout.join("").split("\n").map((line) => JSON.parse(line)),
    ).toEqual([JSON.parse(assistant("stdout-first")), JSON.parse(assistant("stdout-last"))]);
    expect(
      byPipe.stderr.join("").split("\n").map((line) => JSON.parse(line)),
    ).toEqual([JSON.parse(assistant("stderr-first")), JSON.parse(assistant("stderr-last"))]);
  });

  it.each(["stdout", "stderr"] as const)(
    "preserves numeric control validity on %s when display redaction invalidates JSON, keeps unaffected order, awaits slow sink",
    async (pipe) => {
      const secret = "123456";
      const live = JSON.stringify({ role: "assistant", content: "live", ignored: Number(secret) });
      const unaffected = assistant(`unaffected-${pipe}`);
      const fd = pipe === "stdout" ? 1 : 2;
      // Split the secret across two writes so the test exercises the
      // streaming carry, then emit one newline record plus one unterminated
      // EOF record. All values are synthetic and credential-free.
      const script = `
const fs = require('node:fs');
const record = ${JSON.stringify(live)};
const cut = record.indexOf(${JSON.stringify(secret)}) + 3;
fs.writeSync(${fd}, record.slice(0, cut));
setTimeout(() => fs.writeSync(${fd}, record.slice(cut) + '\\n'), 20);
setTimeout(() => fs.writeSync(${fd}, ${JSON.stringify(unaffected)}), 40);
`;
      const logs: string[] = [];
      const batches: Array<{ stream: ControlPipe; records: string }> = [];
      const onControlOutput: ControlCallback = async (stream, records) => {
        // Slow sink: the wrapper must await each callback so no record is
        // lost when the consumer is slower than the child.
        await new Promise((resolve) => setTimeout(resolve, 30));
        batches.push({ stream, records });
      };
      const result = await runAdapterExecutionTargetProcess(
        randomUUID(),
        null,
        process.execPath,
        ["-e", script],
        {
          ...baseOptions({ CLIENT_SECRET: secret }),
          onLog: async (stream, chunk) => {
            if (stream === pipe) logs.push(chunk);
          },
          onControlOutput,
        },
      );
      expect(result.exitCode).toBe(0);
      // Display log redacts the literal secret and is no longer valid JSON
      // for the affected record; control output replaces the numeric token
      // with 0 and stays valid. This is the display-invalid/control-valid split.
      expect(logs.join("")).toBe(result[pipe]);
      expect(result[pipe]).toContain('"ignored":***REDACTED***');
      const pipeBatches = batches.filter((entry) => entry.stream === pipe);
      expect(pipeBatches.length).toBeGreaterThan(0);
      const joined = pipeBatches.map((entry) => entry.records).join("");
      expect(joined).not.toContain(secret);
      expect(joined.split("\n").map((line) => JSON.parse(line))).toEqual([
        { role: "assistant", content: "live", ignored: 0 },
        JSON.parse(unaffected),
      ]);
      // Unaffected record survives verbatim and order is preserved.
      expect(joined).toContain(unaffected);
      // The opposite pipe carries no records for this single-pipe script.
      const otherPipe = pipe === "stdout" ? "stderr" : "stdout";
      expect(
        batches.filter((entry) => entry.stream === otherPipe).map((entry) => entry.records).join(""),
      ).toBe("");
    },
  );
});

describe("execution-target control-output SSH forwarding (source-confirmed, no host execution)", () => {
  it("passes the identical onControlOutput reference through to runChildProcess with the SSH spec", async () => {
    const sshTarget = {
      kind: "remote" as const,
      transport: "ssh" as const,
      remoteCwd: "/srv/paperclip/workspace",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/paperclip/workspace",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    const onControlOutput: ControlCallback = async () => {};
    const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });
    try {
      await runAdapterExecutionTargetProcess(
        "run-ssh-control-forward",
        sshTarget,
        "agent-cli",
        ["--json"],
        {
          cwd: "/tmp/local",
          env: { SAFE_VALUE: "visible" },
          timeoutSec: 5,
          graceSec: 1,
          onLog: async () => {},
          onControlOutput,
        },
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const forwarded = spy.mock.calls[0]?.[3];
      // Identity check proves the wrapper does not discard or wrap the live
      // event callback. This test contacts no host; it only confirms the
      // forwarding edge into runChildProcess with the SSH remote spec.
      expect(forwarded).toMatchObject({
        onControlOutput,
        remoteExecution: sshTarget.spec,
      });
      expect(forwarded?.onControlOutput).toBe(onControlOutput);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// Sandbox live control records (Greptile P2 on #14390): the sandbox runner
// has no control channel, so runAdapterExecutionTargetProcess rebuilds the
// ordered sanitized records from the raw streamed bytes. All secrets below
// are synthetic and credential-free.
const sandboxAssistant = (content: string) => JSON.stringify({ role: "assistant", content });
const sandboxTool = (name: string, content: string) =>
  JSON.stringify({ role: "tool", name, content });

function parseControlRecords(joined: string): unknown[] {
  // Trailing newlines are normal in streamed controls; a bare split("\n")
  // yields a final empty string that JSON.parse chokes on, so filter first.
  return joined
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

interface SandboxHarness {
  target: {
    kind: "remote";
    transport: "sandbox";
    remoteCwd: string;
    runner: {
      execute: (input: {
        onLog?: (stream: ControlPipe, chunk: string) => Promise<void>;
      }) => Promise<{
        exitCode: number;
        signal: null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
        pid: null;
        startedAt: string;
      }>;
    };
  };
  runLogTail: {
    create: () => {
      wrapCommand: (command: string, args: string[]) => { command: string; args: string[] };
      start: (onLog: (stream: ControlPipe, chunk: string) => Promise<void>) => void;
      finish: (finalBatch: { stdout: string; stderr: string }) => Promise<void>;
      abort: () => Promise<void>;
    };
  } | null;
}

/**
 * Fake sandbox pair mirroring the production topology: the tail handle
 * captures the streaming sink at start(); the fake runner emits incremental
 * chunks through that sink during execute() (tail path) or through the
 * runner-level onLog (no-tail path), then returns the full batched result.
 * The finish() suffix covers bytes the poll loop had not streamed yet.
 */
function makeSandboxHarness(options: {
  streamed: Array<{ stream: ControlPipe; chunk: string }>;
  suffixStdout?: string;
  suffixStderr?: string;
  finalStdout: string;
  finalStderr?: string;
  useTail: boolean;
}): SandboxHarness {
  let sink: ((stream: ControlPipe, chunk: string) => Promise<void>) | null = null;
  const suffixStdout = options.suffixStdout ?? "";
  const suffixStderr = options.suffixStderr ?? "";
  return {
    target: {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: {
        execute: async (input) => {
          if (options.useTail) {
            for (const item of options.streamed) {
              await sink?.(item.stream, item.chunk);
            }
          } else {
            for (const item of options.streamed) {
              await input.onLog?.(item.stream, item.chunk);
            }
          }
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: options.finalStdout,
            stderr: options.finalStderr ?? "",
            pid: null,
            startedAt: new Date().toISOString(),
          };
        },
      },
    },
    runLogTail: options.useTail
      ? {
          create: () => ({
            wrapCommand: (command: string, args: string[]) => ({ command, args }),
            start: (onLog) => {
              sink = onLog;
            },
            finish: async () => {
              if (suffixStdout) await sink?.("stdout", suffixStdout);
              if (suffixStderr) await sink?.("stderr", suffixStderr);
            },
            abort: async () => {},
          }),
        }
      : null,
  };
}

describe("execution-target sandbox control-output forwarding (fake runner, no host execution)", () => {
  it("delivers sanitized assistant/tool events before exit on the tail path with a chunk-split secret", async () => {
    const secret = "s3cr3t-sync-token-abc";
    const first = sandboxAssistant("streamed-first");
    const live = sandboxAssistant(`live ${secret} event`);
    const tool = sandboxTool("read", "ok");
    const eofRecord = sandboxAssistant("eof-last");
    // Split the secret across two streamed chunks so the test exercises the
    // cross-chunk carry; the streamed text ends with a trailing newline and
    // the EOF record arrives unterminated via the finish() suffix.
    const cut = live.indexOf(secret) + 4;
    const streamedStdout = `${first}\n${live.slice(0, cut)}`;
    const streamedRest = `${live.slice(cut)}\n${tool}\n`;
    const harness = makeSandboxHarness({
      streamed: [
        { stream: "stdout", chunk: streamedStdout },
        { stream: "stderr", chunk: '{"role":"assistant","content":"stderr-note"}\n' },
        { stream: "stdout", chunk: streamedRest },
      ],
      suffixStdout: eofRecord,
      finalStdout: `${streamedStdout}${streamedRest}${eofRecord}`,
      finalStderr: '{"role":"assistant","content":"stderr-note"}\n',
      useTail: true,
    });
    const logs: string[] = [];
    const byPipe: Record<ControlPipe, string[]> = { stdout: [], stderr: [] };
    const result = await runAdapterExecutionTargetProcess(
      randomUUID(),
      harness.target,
      "agent-cli",
      ["--json"],
      {
        ...baseOptions({ CLIENT_SECRET: secret }),
        onLog: async (stream, chunk) => {
          logs.push(`${stream}:${chunk}`);
        },
        onControlOutput: async (stream, records) => {
          byPipe[stream].push(records);
        },
        runLogTail: harness.runLogTail,
      },
    );
    expect(result.exitCode).toBe(0);
    // Display bytes pass through untouched on the sandbox path (sandbox
    // display capture is outside the redaction claim); control records must
    // never carry the literal secret. Per-pipe byte order is preserved even
    // though the stderr chunk interleaves between the two stdout halves, so
    // the raw stdout halves (which split the secret) rejoin exactly.
    const stdoutLogs = logs
      .filter((entry) => entry.startsWith("stdout:"))
      .map((entry) => entry.slice("stdout:".length))
      .join("");
    expect(stdoutLogs).toBe(`${streamedStdout}${streamedRest}${eofRecord}`);
    expect(stdoutLogs).toContain(secret);
    const stdoutControls = byPipe.stdout.join("");
    expect(stdoutControls).not.toContain(secret);
    expect(parseControlRecords(stdoutControls)).toEqual([
      JSON.parse(first),
      // The whole affected string token is replaced, not the secret
      // substring: control redaction keeps the record valid, never patched.
      { role: "assistant", content: "***REDACTED***" },
      JSON.parse(tool),
      JSON.parse(eofRecord),
    ]);
    // Control output redacts the value while display keeps it: the split is
    // the point, so the two views must differ exactly on the secret.
    expect(stdoutControls).toContain("***REDACTED***");
    // The stderr pipe stays independent and ordered.
    expect(parseControlRecords(byPipe.stderr.join(""))).toEqual([
      { role: "assistant", content: "stderr-note" },
    ]);
  });

  it("falls back to the final batch for a pipe that never streamed, without duplicating streamed pipes", async () => {
    const secret = "batched-fallback-token-99";
    const first = sandboxAssistant("batched-first");
    const second = sandboxAssistant(`batched ${secret} second`);
    // The runner never calls onLog: the whole output arrives only in the
    // batched result, so the fallback must still deliver sanitized records
    // before exit.
    const harness = makeSandboxHarness({
      streamed: [],
      finalStdout: `${first}\n${second}\n`,
      useTail: false,
    });
    const byPipe: Record<ControlPipe, string[]> = { stdout: [], stderr: [] };
    const result = await runAdapterExecutionTargetProcess(
      randomUUID(),
      harness.target,
      "agent-cli",
      ["--json"],
      {
        ...baseOptions({ CLIENT_SECRET: secret }),
        onControlOutput: async (stream, records) => {
          byPipe[stream].push(records);
        },
        runLogTail: harness.runLogTail,
      },
    );
    expect(result.exitCode).toBe(0);
    const stdoutControls = byPipe.stdout.join("");
    expect(stdoutControls).not.toContain(secret);
    expect(parseControlRecords(stdoutControls)).toEqual([
      JSON.parse(first),
      { role: "assistant", content: "***REDACTED***" },
    ]);
  });

  it("leaves display behavior unchanged when no onControlOutput is subscribed", async () => {
    const body = `${sandboxAssistant("plain")}\n${sandboxAssistant("records")}`;
    const harness = makeSandboxHarness({
      streamed: [{ stream: "stdout", chunk: `${body}\n` }],
      finalStdout: `${body}\n`,
      finalStderr: "warn\n",
      useTail: true,
    });
    const logs: string[] = [];
    const result = await runAdapterExecutionTargetProcess(
      randomUUID(),
      harness.target,
      "agent-cli",
      ["--json"],
      {
        ...baseOptions(),
        onLog: async (stream, chunk) => {
          logs.push(`${stream}:${chunk}`);
        },
        runLogTail: harness.runLogTail,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${body}\n`);
    expect(logs.join("")).toContain(body);
  });
});
