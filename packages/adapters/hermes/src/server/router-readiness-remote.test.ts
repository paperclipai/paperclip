/**
 * TECH-8174: the in-sandbox Ramp Router probe, run for real. The "sandbox" runner here executes the
 * exact command/args/env the probe sends, with a local /bin/sh, against real minimal Hermes installs
 * (a real venv + editable source root, like /opt/hermes in the image).
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

import { probeHermesRouterSupportInTarget, REMOTE_ROUTER_PROBE_WRAPPER } from "./router-readiness-remote.js";
import { createFakeHermesInstall, UPSTREAM_ROUTER_PROFILE } from "./test-support/fake-hermes-install.js";

interface Exec {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdin?: string;
}

let root: string;
let execs: Exec[];
/** Env already present in the "pod" (outside anything the probe sends). */
let podAmbientEnv: Record<string, string>;

function localSandbox(): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "test",
    remoteCwd: root,
    runner: {
      execute: (input: { command: string; args: string[]; cwd: string; env: Record<string, string>; stdin?: string; timeoutMs?: number }) =>
        new Promise((resolve) => {
          execs.push({ command: input.command, args: input.args, env: input.env, stdin: input.stdin });
          const child = spawn(input.command, input.args, {
            cwd: input.cwd,
            // A pod's base env: PATH only. The probe must not depend on anything else.
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...podAmbientEnv, ...input.env },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (c) => (stdout += c));
          child.stderr.on("data", (c) => (stderr += c));
          child.on("close", (code, signal) =>
            resolve({ exitCode: code, signal, timedOut: false, stdout, stderr, pid: child.pid ?? null, startedAt: new Date().toISOString() }),
          );
        }),
    },
  } as unknown as AdapterExecutionTarget;
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-remote-probe-")));
  execs = [];
  podAmbientEnv = {};
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function probe(binDir: string) {
  const probeDir = path.join(root, "runtime", "router-probe");
  const result = await probeHermesRouterSupportInTarget({
    runId: "run-probe",
    target: localSandbox(),
    cwd: root,
    probeDir,
    hermesBinDir: binDir,
  });
  return { result, probeDir };
}

// Each case builds a real venv; allow for a loaded CI runner.
describe("probeHermesRouterSupportInTarget (TECH-8174)", { timeout: 30_000 }, () => {
  it("verifies the native Router provider through the target's own venv and cleans up", async () => {
    const install = await createFakeHermesInstall(path.join(root, "image"), { layout: "venv-editable" });
    const { result, probeDir } = await probe(install.binDir);
    expect(result).toEqual({ supported: true });
    // One exec, no env (no credentials), the fixed wrapper; the probe dir is removed afterwards.
    expect(execs).toHaveLength(1);
    expect(execs[0]!.command).toBe("sh");
    expect(execs[0]!.args[1]).toBe(REMOTE_ROUTER_PROBE_WRAPPER);
    expect(execs[0]!.env).toEqual({});
    await expect(fs.stat(probeDir)).rejects.toThrow();
    // The probe never imported the CLI entrypoint module.
    await expect(fs.stat(path.join(install.srcRoot, "hermes_cli", ".main-imported"))).rejects.toThrow();
  });

  it("reports an install without the native provider as unsupported", async () => {
    const install = await createFakeHermesInstall(path.join(root, "image"), {
      layout: "venv-editable",
      profile: { ...UPSTREAM_ROUTER_PROFILE, base_url: "https://elsewhere.example/v1" },
    });
    const { result } = await probe(install.binDir);
    expect(result).toMatchObject({ supported: false, reason: "unsupported" });
    expect((result as { message: string }).message).toContain("profile_base_url");
  });

  it("refuses a launcher that is a symlink to something else", async () => {
    const install = await createFakeHermesInstall(path.join(root, "image"), { layout: "venv-editable" });
    const elsewhere = path.join(root, "elsewhere-hermes");
    await fs.rename(install.command, elsewhere);
    await fs.symlink(elsewhere, install.command);
    const { result } = await probe(install.binDir);
    expect(result).toMatchObject({ supported: false, reason: "unknown" });
    expect((result as { message: string }).message).toContain("not the Hermes virtualenv's own entrypoint");
  });

  it("refuses a launcher whose shebang is not the venv interpreter", async () => {
    const install = await createFakeHermesInstall(path.join(root, "image"), { layout: "venv-editable", shebang: "env" });
    const { result } = await probe(install.binDir);
    expect(result).toMatchObject({ supported: false, reason: "unknown" });
  });

  it("refuses a probe dir with dot segments before mkdir or rm -rf", async () => {
    const install = await createFakeHermesInstall(path.join(root, "image"), { layout: "venv-editable" });
    const keep = path.join(root, "keep");
    await fs.mkdir(keep);
    const result = await probeHermesRouterSupportInTarget({
      runId: "run-probe",
      target: localSandbox(),
      cwd: root,
      probeDir: `${keep}/sub/..`,
      hermesBinDir: install.binDir,
    });
    expect(result).toMatchObject({ supported: false });
    await expect(fs.stat(keep)).resolves.toBeTruthy();
  });

  it("refuses a relative probe dir without creating or removing anything", async () => {
    const install = await createFakeHermesInstall(path.join(root, "image"), { layout: "venv-editable" });
    const result = await probeHermesRouterSupportInTarget({
      runId: "run-probe",
      target: localSandbox(),
      cwd: root,
      probeDir: "relative/probe",
      hermesBinDir: install.binDir,
    });
    expect(result).toMatchObject({ supported: false, reason: "unknown" });
    await expect(fs.stat(path.join(root, "relative"))).rejects.toThrow();
  });

  it("scrubs ambient credentials and import-path overrides from the probe's Python process", async () => {
    const install = await createFakeHermesInstall(path.join(root, "image"), {
      layout: "venv-editable",
      providersExtra: "import os\nif os.environ.get('RAMP_ROUTER_API_KEY') or os.environ.get('PYTHONPATH'):\n    raise RuntimeError('leaked env')",
    });
    podAmbientEnv = { RAMP_ROUTER_API_KEY: "rr-must-not-leak", PYTHONPATH: path.join(root, "shadow") };
    const { result } = await probe(install.binDir);
    expect(result).toEqual({ supported: true });
  });
});
