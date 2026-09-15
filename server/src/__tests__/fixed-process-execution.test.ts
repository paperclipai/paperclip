import { describe, expect, it } from "vitest";
import { execute } from "../adapters/process/execute.js";
import { assertFixedProcessExecution, assertFixedProcessUnresolvedEnvironment, captureFixedProcessEnvironment } from "../adapters/process/fixed-command.js";
const saved = { fixedCommand: true, command: "/bin/bash", args: ["/service/watchdog.sh"], cwd: "/service" };
describe("fixed process execution", () => {
  it("accepts the administratively stored invocation", () => {
    expect(() => assertFixedProcessExecution(saved, saved, {})).not.toThrow();
  });
  it.each([
    { ...saved, command: "/bin/other" },
    { ...saved, args: ["-c", "arbitrary command"] },
    { ...saved, cwd: "/other" },
  ])("rejects a changed executable tuple before spawning", (effective) => {
    expect(() => assertFixedProcessExecution(saved, effective, {})).toThrow();
  });
  it.each(["issueId", "taskId", "projectId"])("rejects execution through %s", (key) => {
    expect(() => assertFixedProcessExecution(saved, saved, { [key]: "untrusted" })).toThrow();
  });
  it("rejects environment injection even when the command tuple is unchanged", () => {
    expect(() => assertFixedProcessExecution(saved, { ...saved, env: { BASH_ENV: "/untrusted/startup.sh" } }, {})).toThrow();
  });
  it("does not alter ordinary process execution", () => {
    expect(() => assertFixedProcessExecution({}, { command: "custom" }, { issueId: "ordinary" })).not.toThrow();
  });
  it("binds resolved secrets and rejects substitutions before and after resolution", () => {
    const config = { ...saved, env: { KEY: { type: "secret_ref", secretId: "approved", version: "latest" } } };
    expect(() => assertFixedProcessUnresolvedEnvironment(config, config, [])).not.toThrow();
    expect(() => assertFixedProcessUnresolvedEnvironment(config, { ...config, env: { KEY: { type: "secret_ref", secretId: "other" } } }, [])).toThrow();
    expect(() => assertFixedProcessUnresolvedEnvironment(config, config, [{ BASH_ENV: "/untrusted" }])).toThrow();
    const resolved = { ...config, env: { KEY: "synthetic-resolved" } };
    const approve = captureFixedProcessEnvironment(config, resolved);
    const runtime = { ...resolved, env: { ...resolved.env } };
    expect(() => assertFixedProcessExecution(config, runtime, {})).toThrow();
    approve(runtime);
    expect(() => assertFixedProcessExecution(config, runtime, {})).not.toThrow();
    runtime.env.KEY = "substituted";
    expect(() => assertFixedProcessExecution(config, runtime, {})).toThrow();
    expect(() => approve(runtime)).toThrow();
  });

});

it("does not inherit unapproved server variables into a fixed process", async () => {
  const variable = "ZOL13738_SYNTHETIC_AMBIENT";
  const previous = process.env[variable];
  process.env[variable] = "synthetic";
  try {
    for (const fixedCommand of [true, false]) {
      const config = { fixedCommand, command: process.execPath, cwd: process.cwd(),
        args: ["-e", `process.exit(process.env.${variable} === 'synthetic' ? 23 : 0)`] };
      const result = await execute({ runId: "ambient-regression",
        agent: { id: "ambient-regression", companyId: "isolated", name: "Synthetic process", adapterType: "process", adapterConfig: config },
        config, context: {}, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        onLog: async () => {},
      });
      expect(result.exitCode).toBe(fixedCommand ? 0 : 23);
    }
  } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
  }
});
