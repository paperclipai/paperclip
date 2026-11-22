import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

vi.mock("./detect-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./detect-model.js")>();
  return { ...actual, detectModel: vi.fn(async () => null) };
});

import { testEnvironment } from "./test.js";

type Reply = { stdout?: string; error?: NodeJS.ErrnoException };

function replyWith(handler: (command: string, args: string[]) => Reply) {
  execFileMock.mockImplementation((command: string, args: string[], _opts: unknown, callback: Function) => {
    const reply = handler(command, args);
    if (reply.error) callback(reply.error);
    else callback(null, { stdout: reply.stdout ?? "", stderr: "" });
  });
}

function version(command: string): Reply {
  return { stdout: command === "python3" ? "Python 3.12.1\n" : "Hermes Agent v0.23.3\n" };
}

function isProbe(args: string[]) {
  return args.includes("chat") && args.includes("-q");
}

function ctx(config: Record<string, unknown> = {}, executionTarget?: unknown) {
  return {
    companyId: "company-1",
    adapterType: "hermes_local",
    config: { hermesCommand: "/usr/local/bin/hermes", ...config },
    ...(executionTarget ? { executionTarget } : {}),
  } as any;
}

describe("hermes_local testEnvironment hello probe", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("runs a hello probe for a host-configured Hermes and reports it as passed", async () => {
    replyWith((command, args) => (isProbe(args) ? { stdout: "Hello!\n\nsession_id: local-abc\n" } : version(command)));

    const result = await testEnvironment(ctx());

    expect(execFileMock.mock.calls.some(([, args]) => isProbe(args))).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({ level: "info", code: "hermes_hello_probe_passed" }));
    expect(result.status).not.toBe("fail");
  });

  it("fails the test when the hello probe gets no hello back", async () => {
    replyWith((command, args) => (isProbe(args) ? { stdout: "Error: no provider configured\n" } : version(command)));

    const result = await testEnvironment(ctx());

    expect(result.checks).toContainEqual(expect.objectContaining({ level: "error", code: "hermes_hello_probe_failed" }));
    expect(result.status).toBe("fail");
  });

  it("does not run a hello probe when the Hermes CLI is missing", async () => {
    replyWith(() => ({ error: Object.assign(new Error("not found"), { code: "ENOENT" }) }));

    const result = await testEnvironment(ctx());

    expect(execFileMock.mock.calls.some(([, args]) => isProbe(args))).toBe(false);
    expect(result.status).toBe("fail");
  });

  it("does not run a local hello probe for a remote execution target", async () => {
    replyWith((command) => version(command));

    await testEnvironment(ctx({}, { kind: "remote" }));

    expect(execFileMock.mock.calls.some(([, args]) => isProbe(args))).toBe(false);
  });
});
