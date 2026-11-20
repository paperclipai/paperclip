import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SANDBOX_NODE_SHA256,
  SANDBOX_NODE_VERSION,
  buildEnsureNpmPreamble,
  buildSandboxNpmInstallCommand,
} from "./sandbox-install-command.js";

// Runs the bootstrap preamble for real against stubbed `curl` and `uname`, so the
// checksum gate is exercised rather than asserted from the string.
describe("Node bootstrap checksum gate", () => {
  let root: string;
  let home: string;
  let stubBin: string;
  let fixtureSha: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "node-bootstrap-"));
    home = path.join(root, "home");
    stubBin = path.join(root, "bin");
    fs.mkdirSync(home);
    fs.mkdirSync(stubBin);

    const payload = path.join(root, "node-v0.0.0-linux-arm64", "bin");
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, "npm"), "#!/bin/sh\necho npm-fixture\n", { mode: 0o755 });
    const tarball = path.join(root, "fixture.tar.xz");
    execFileSync("tar", ["-cJf", tarball, "-C", root, "node-v0.0.0-linux-arm64"]);
    fixtureSha = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");

    fs.writeFileSync(
      path.join(stubBin, "curl"),
      [
        "#!/bin/sh",
        'out=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done',
        `cp "${tarball}" "$out"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(stubBin, "uname"), "#!/bin/sh\necho aarch64\n", { mode: 0o755 });
    // A failing `node` stub shadows any host Node in /usr/bin or /bin, so the
    // version probe fails and the preamble always takes the bootstrap branch.
    fs.writeFileSync(path.join(stubBin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(preamble: string) {
    return spawnSync("sh", ["-c", `${preamble} echo "BOOT=$PAPERCLIP_NPM_BOOTSTRAPPED"`], {
      env: { HOME: home, PATH: `${stubBin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
  }

  it("extracts the tarball when the checksum matches", () => {
    const result = run(buildEnsureNpmPreamble("v0.0.0", { arm64: fixtureSha }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("BOOT=1");
    expect(fs.existsSync(path.join(home, ".local", "bin", "npm"))).toBe(true);
  });

  it("aborts before extracting when the checksum does not match", () => {
    const result = run(buildEnsureNpmPreamble("v0.0.0", { arm64: "f".repeat(64) }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(result.stdout).not.toContain("BOOT=");
    expect(fs.existsSync(path.join(home, ".local", "bin", "npm"))).toBe(false);
  });

  it("aborts on architectures without a pinned checksum", () => {
    const result = run(buildEnsureNpmPreamble("v0.0.0", { x64: fixtureSha }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no pinned checksum for linux-arm64");
  });

  it("pins a patched Node 24 release for both Linux architectures", () => {
    expect(SANDBOX_NODE_VERSION).toBe("v24.22.1");
    expect(Object.keys(SANDBOX_NODE_SHA256).sort()).toEqual(["arm64", "x64"]);
    for (const sha of Object.values(SANDBOX_NODE_SHA256)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildSandboxNpmInstallCommand", () => {
  it("installs globally as root, via sudo when available, and under ~/.local otherwise", () => {
    const command = buildSandboxNpmInstallCommand("@google/gemini-cli");
    expect(command).toContain("if [ \"$(id -u)\" -eq 0 ]; then npm install -g '@google/gemini-cli';");
    expect(command).toContain("sudo -E npm install -g '@google/gemini-cli'");
    expect(command).toContain("npm install -g --prefix \"$HOME/.local\" '@google/gemini-cli'");
  });

  it("bootstraps npm from a portable Node tarball when missing or unsupported", () => {
    const command = buildSandboxNpmInstallCommand("@google/gemini-cli");
    expect(command).toContain("if ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 ||");
    expect(command).toContain("process.versions.node");
    expect(command).toContain("v[0]>24||(v[0]===24&&v[1]>=11)");
    expect(command).toContain("https://nodejs.org/dist/");
    expect(command).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it("shell-quotes package names", () => {
    expect(buildSandboxNpmInstallCommand("odd'pkg")).toContain("'odd'\"'\"'pkg'");
  });
});
