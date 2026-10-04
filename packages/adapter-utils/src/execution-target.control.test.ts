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
