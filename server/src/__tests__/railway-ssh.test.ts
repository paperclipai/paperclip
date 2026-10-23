import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instanceId } from "./fixtures/railway/provider.js";
const { spawnMock, accessMock, execFileMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), accessMock: vi.fn(), execFileMock: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock.mockImplementation(actual.execFile) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, access: accessMock.mockImplementation(actual.access) };
});
import { generateRailwaySshKey, railwaySshArguments, runRailwaySshCommand, validateRailwayKnownHosts } from "../services/railway-ssh.js";

const host = "ssh.railway.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture";
function input(signal = new AbortController().signal) { return { deploymentInstanceId: instanceId, command: "printf 'hello'", timeoutSeconds: 1, privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n", knownHosts: host, signal }; }
function fakeProcess(action: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> }, script: string) => void) {
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null)); return true; }) });
    let script = "";
    child.stdin.on("data", (chunk) => { script += chunk; });
    child.stdin.on("finish", () => action(child, script));
    return child;
  });
}
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  accessMock.mockImplementation(actual.access);
  const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  execFileMock.mockImplementation(childProcess.execFile);
});

describe("Railway isolated container command runner", () => {
  it("generates a fresh real key without retaining files", async () => {
    vi.stubEnv("PATH", "/nonexistent/ambient-openssh");
    const key = await generateRailwaySshKey();
    expect(key.publicKey).toMatch(/^ssh-ed25519 /);
    expect(key.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
  });
  it.each(["ENOENT", "EACCES"])("uses system-profile keygen when earlier locations fail with %s", async (code) => {
    accessMock.mockImplementation(async (file) => {
      if (file !== "/run/current-system/sw/bin/ssh-keygen") throw Object.assign(new Error("unavailable"), { code });
    });
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const keyPath = args[args.indexOf("-f") + 1];
      void Promise.all([
        writeFile(keyPath, "fixture-private-key", { mode: 0o600 }),
        writeFile(`${keyPath}.pub`, "fixture-public-key\n"),
      ]).then(() => callback(null, "", ""), callback);
    });
    await expect(generateRailwaySshKey()).resolves.toEqual({
      publicKey: "fixture-public-key", privateKey: "fixture-private-key",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFileMock.mock.calls[0];
    expect(command).toBe("/run/current-system/sw/bin/ssh-keygen");
    expect(options.env).toEqual({ PATH: "/usr/bin:/bin" });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await expect(actual.access(path.dirname(args[args.indexOf("-f") + 1]))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["/usr/bin", "/bin", "/run/current-system/sw/bin"])("uses OpenSSH from the trusted %s directory", async (directory) => {
    accessMock.mockImplementation(async (file) => {
      if (file !== path.join(directory, "ssh")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    });
    vi.stubEnv("PATH", "/workspace/bin:/nix/store/00000000000000000000000000000000-untrusted/bin");
    fakeProcess((child, script) => {
      const marker = script.match(/paperclip_railway_completed_[a-f0-9]+/)![0];
      child.stdout.write(`\n${marker}:0\n`);
      child.emit("close", 0);
    });
    await expect(runRailwaySshCommand(input())).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnMock.mock.calls[0][0]).toBe(path.join(directory, "ssh"));
    expect(spawnMock.mock.calls[0][2].env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
  });
  it("fails closed when only ambient OpenSSH paths could be available", async () => {
    const ambient = "/nix/store/00000000000000000000000000000000-untrusted/bin";
    vi.stubEnv("PATH", ambient);
    accessMock.mockImplementation(async (file) => {
      if (file !== path.join(ambient, "ssh")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    });
    await expect(runRailwaySshCommand(input())).rejects.toMatchObject({ code: "railway_ssh_unavailable" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(accessMock.mock.calls.map(([file]) => file)).toEqual([
      "/usr/bin/ssh", "/bin/ssh", "/run/current-system/sw/bin/ssh",
    ]);
  });
  it("rejects untrusted aliases and ambient SSH state", () => {
    for (const line of ["* ssh-ed25519 AAAA", "evil.test ssh-ed25519 AAAA", `${host}\nHost *`, "@cert-authority " + host]) expect(() => validateRailwayKnownHosts(line)).toThrow();
    const args = railwaySshArguments("/tmp/dedicated", instanceId);
    expect(args).toEqual(expect.arrayContaining(["/dev/null", "IdentityAgent=none", "StrictHostKeyChecking=yes", "IdentitiesOnly=yes", "ForwardAgent=no", "ControlPath=none"]));
    expect(args.slice(-3)).toEqual(["--", `${instanceId}@ssh.railway.com`, "sh -s"]);
  });
  it("requires remote completion and cleans its isolated directory", async () => {
    fakeProcess((child, script) => {
      expect(script).toContain("</dev/null");
      const marker = script.match(/paperclip_railway_completed_[a-f0-9]+/)![0];
      child.stdout.write(`hello\n${marker}:7\n`);
      child.emit("close", 7);
    });
    await expect(runRailwaySshCommand(input())).resolves.toMatchObject({ exitCode: 7, stdout: "hello", timedOut: false, truncated: false });
    const args = spawnMock.mock.calls[0][1] as string[];
    const keyPath = args[args.indexOf("-i") + 1];
    await expect(access(path.dirname(keyPath))).rejects.toThrow();
    expect(spawnMock.mock.calls[0][2].env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
  });
  it("never treats local success or stdin failure as confirmed remote success", async () => {
    fakeProcess((child) => { child.stdin.emit("error", new Error("EPIPE")); child.emit("close", 0); });
    await expect(runRailwaySshCommand(input())).rejects.toMatchObject({ code: "railway_ssh_command_unconfirmed" });
  });
  it("kills commands that exceed the output limit", async () => {
    fakeProcess((child) => { child.stdout.write("x".repeat(70000)); });
    const result = await runRailwaySshCommand(input());
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(65536);
  });
  it("kills on timeout and cancellation and still removes private material", async () => {
    fakeProcess(() => {});
    const result = await runRailwaySshCommand(input());
    expect(result.timedOut).toBe(true);
    const controller = new AbortController();
    fakeProcess(() => controller.abort());
    await expect(runRailwaySshCommand(input(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    const args = spawnMock.mock.calls.at(-1)![1] as string[];
    await expect(readFile(args[args.indexOf("-i") + 1])).rejects.toThrow();
  });
});
