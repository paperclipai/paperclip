import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTH_JSON_FILE_NAME,
  DEVICE_LOGIN_AUTH_READ_ERROR,
  DEVICE_LOGIN_AUTH_READ_SCRIPT,
  MAX_AUTH_JSON_BYTES,
  decodeAuthReadOutput,
  runDescriptorBoundAuthRead,
} from "../services/codex-device-login-credential-read.ts";

// The helper runs `python3`. The login sandbox image ships python3. A host with
// no python3 skips the script tests and keeps the pure-decode tests.
function hasPython3(): boolean {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

const python3Available = hasPython3();
const describePython = python3Available ? describe : describe.skip;

if (!python3Available) {
  console.warn("Skipping descriptor-bound read script tests on this host: python3 is not available.");
}

describe("decodeAuthReadOutput", () => {
  it("decodes strict base64 to the exact bytes", () => {
    const payload = Buffer.from('{"tokens":{"refresh_token":"r"}}', "utf8");
    const decoded = decodeAuthReadOutput(payload.toString("base64"));
    expect(decoded.equals(payload)).toBe(true);
  });

  it("tolerates a trailing newline from the helper", () => {
    const payload = Buffer.from("abc", "utf8");
    const decoded = decodeAuthReadOutput(`${payload.toString("base64")}\n`);
    expect(decoded.toString("utf8")).toBe("abc");
  });

  it("returns an empty buffer for empty output", () => {
    expect(decodeAuthReadOutput("").length).toBe(0);
  });

  it("rejects a non-base64 payload", () => {
    expect(() => decodeAuthReadOutput("not*base64*text")).toThrow(DEVICE_LOGIN_AUTH_READ_ERROR);
  });

  it("rejects a wrong-padding payload", () => {
    // A single stray character is not a multiple of four, so it is malformed.
    expect(() => decodeAuthReadOutput("QQ")).toThrow(DEVICE_LOGIN_AUTH_READ_ERROR);
  });

  it("rejects a decoded payload over the bound", () => {
    const oversize = Buffer.alloc(MAX_AUTH_JSON_BYTES + 1, 0x61).toString("base64");
    expect(() => decodeAuthReadOutput(oversize)).toThrow(DEVICE_LOGIN_AUTH_READ_ERROR);
  });
});

describePython("the descriptor-bound read helper script", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "codex-auth-read-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Run the helper against `home`. An explicit `expectedUid` forces the owner
  // check; the production caller omits it and the helper uses its own uid.
  function runScript(home: string, expectedUid?: number): { status: number | null; stdout: string } {
    const args = ["-c", DEVICE_LOGIN_AUTH_READ_SCRIPT, home];
    if (expectedUid !== undefined) args.push(String(expectedUid));
    const result = spawnSync("python3", args, { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "" };
  }

  // Build a fresh session home with a `0700` directory. The caller writes the
  // credential file inside it.
  function makeHome(name: string): string {
    const home = path.join(root, name);
    mkdirSync(home, { mode: 0o700 });
    return home;
  }

  it("reads a regular 0600 credential owned by the login user", () => {
    const home = makeHome("valid");
    const payload = '{"tokens":{"refresh_token":"r"}}';
    const file = path.join(home, AUTH_JSON_FILE_NAME);
    writeFileSync(file, payload, { mode: 0o600 });
    chmodSync(file, 0o600);
    const { status, stdout } = runScript(home);
    expect(status).toBe(0);
    expect(Buffer.from(stdout.trim(), "base64").toString("utf8")).toBe(payload);
  });

  it("rejects a missing credential", () => {
    const home = makeHome("missing");
    expect(runScript(home).status).not.toBe(0);
  });

  it("rejects a symlink credential (a swap between the check and the read)", () => {
    // The attacker swaps `auth.json` for a symlink to a file outside the home.
    // The single no-follow open rejects the symlink, so the read never follows
    // it. There is no separate check to race.
    const home = makeHome("symlink");
    const secret = path.join(root, "outside-secret");
    writeFileSync(secret, "outside", { mode: 0o600 });
    symlinkSync(secret, path.join(home, AUTH_JSON_FILE_NAME));
    expect(runScript(home).status).not.toBe(0);
  });

  it("rejects a directory in the credential position", () => {
    const home = makeHome("dir");
    mkdirSync(path.join(home, AUTH_JSON_FILE_NAME), { mode: 0o700 });
    expect(runScript(home).status).not.toBe(0);
  });

  it("rejects a wrong-mode credential", () => {
    const home = makeHome("mode");
    const file = path.join(home, AUTH_JSON_FILE_NAME);
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(runScript(home).status).not.toBe(0);
  });

  it("rejects a wrong-owner credential", () => {
    const home = makeHome("owner");
    const file = path.join(home, AUTH_JSON_FILE_NAME);
    writeFileSync(file, "{}", { mode: 0o600 });
    chmodSync(file, 0o600);
    // Force a uid that differs from the file owner. The check rejects it.
    const bogusUid = process.getuid ? process.getuid()! + 1 : 999999;
    expect(runScript(home, bogusUid).status).not.toBe(0);
  });

  it("rejects an oversize credential", () => {
    const home = makeHome("oversize");
    const file = path.join(home, AUTH_JSON_FILE_NAME);
    writeFileSync(file, Buffer.alloc(MAX_AUTH_JSON_BYTES + 1, 0x61), { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(runScript(home).status).not.toBe(0);
  });

  it("rejects a symlink session home", () => {
    const real = makeHome("real-home");
    const file = path.join(real, AUTH_JSON_FILE_NAME);
    writeFileSync(file, "{}", { mode: 0o600 });
    chmodSync(file, 0o600);
    const link = path.join(root, "home-symlink");
    symlinkSync(real, link);
    expect(runScript(link).status).not.toBe(0);
  });

  it("reads a hardlink credential inside the private home", () => {
    // A hardlink is not a symlink. The no-follow open allows it, and the fstat
    // sees a regular file. A hardlink inside the private `0700` home is not a
    // privilege escalation, so the read returns the linked inode content.
    const home = makeHome("hardlink");
    const backing = path.join(home, "backing.json");
    writeFileSync(backing, '{"ok":true}', { mode: 0o600 });
    chmodSync(backing, 0o600);
    linkSync(backing, path.join(home, AUTH_JSON_FILE_NAME));
    const { status, stdout } = runScript(home);
    expect(status).toBe(0);
    expect(Buffer.from(stdout.trim(), "base64").toString("utf8")).toBe('{"ok":true}');
  });
});

describePython("runDescriptorBoundAuthRead", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "codex-auth-wrap-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // A fake environment runtime that runs the exact command and arguments the
  // wrapper composes. It exercises the real helper against a local home, so the
  // wrapper and the script are tested together. The session home shape must match
  // the validated pattern, so the fake maps the validated home onto a local
  // directory before it runs the helper.
  function createLocalRuntime(localHome: string) {
    return {
      async execute(input: { command: string; args?: string[]; bypassSession?: boolean }) {
        expect(input.command).toBe("python3");
        expect(input.bypassSession).toBe(true);
        const args = [...(input.args ?? [])];
        // Replace the validated session-home argument with the local directory.
        args[args.length - 1] = localHome;
        const result = spawnSync("python3", args, { encoding: "utf8" });
        return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
    };
  }

  // A syntactically valid session home. The wrapper revalidates the shape.
  const VALID_HOME = "/tmp/paperclip-adapter-login/11111111-1111-1111-1111-111111111111";

  it("returns the credential bytes on a valid read", async () => {
    const localHome = mkdtempSync(path.join(root, "valid-"));
    const payload = '{"tokens":{"refresh_token":"r"}}';
    const file = path.join(localHome, AUTH_JSON_FILE_NAME);
    writeFileSync(file, payload, { mode: 0o600 });
    chmodSync(file, 0o600);
    const bytes = await runDescriptorBoundAuthRead({
      environmentRuntime: createLocalRuntime(localHome) as never,
      environment: { id: "env", driver: "sandbox" } as never,
      lease: { id: "lease" } as never,
      sessionHome: VALID_HOME,
      timeoutMs: 1000,
    });
    expect(bytes.toString("utf8")).toBe(payload);
  });

  it("returns the fixed error when the helper exits non-zero", async () => {
    const localHome = mkdtempSync(path.join(root, "missing-"));
    await expect(
      runDescriptorBoundAuthRead({
        environmentRuntime: createLocalRuntime(localHome) as never,
        environment: { id: "env", driver: "sandbox" } as never,
        lease: { id: "lease" } as never,
        sessionHome: VALID_HOME,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(DEVICE_LOGIN_AUTH_READ_ERROR);
  });

  it("rejects an invalid session-home shape before it runs the helper", async () => {
    let executeCalls = 0;
    const runtime = {
      async execute() {
        executeCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await expect(
      runDescriptorBoundAuthRead({
        environmentRuntime: runtime as never,
        environment: { id: "env", driver: "sandbox" } as never,
        lease: { id: "lease" } as never,
        sessionHome: "/etc/passwd",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
    expect(executeCalls).toBe(0);
  });
});
