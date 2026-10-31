import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OPENCODE_SANDBOX_SHA256,
  OPENCODE_SANDBOX_VERSION,
  SANDBOX_INSTALL_COMMAND,
  buildOpenCodeSandboxInstallCommand,
} from "./index.js";

// Runs the generated shell for real against stubbed `curl` and `uname`, so the
// checksum gate is exercised rather than asserted from the string.
describe("OpenCode sandbox install command", () => {
  let root: string;
  let home: string;
  let stubBin: string;
  let fixtureSha: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-install-"));
    home = path.join(root, "home");
    stubBin = path.join(root, "bin");
    fs.mkdirSync(home);
    fs.mkdirSync(stubBin);

    const payload = path.join(root, "payload");
    fs.mkdirSync(payload);
    fs.writeFileSync(path.join(payload, "opencode"), "#!/bin/sh\necho opencode-fixture\n", { mode: 0o755 });
    const tarball = path.join(root, "opencode-linux-arm64.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", payload, "opencode"]);
    fixtureSha = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");

    // curl stub: record the URL, copy the fixture to the -o target.
    fs.writeFileSync(
      path.join(stubBin, "curl"),
      [
        "#!/bin/sh",
        'out=""; url=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
        `echo "$url" > "${path.join(root, "curl-url")}"`,
        `cp "${tarball}" "$out"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(stubBin, "uname"), "#!/bin/sh\necho aarch64\n", { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(command: string) {
    return spawnSync("sh", ["-c", command], {
      env: { HOME: home, PATH: `${stubBin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
  }

  it("installs the pinned release when the checksum matches", () => {
    const result = run(buildOpenCodeSandboxInstallCommand("9.9.9", { "linux-arm64": fixtureSha }) + "true");
    expect(result.status, result.stderr).toBe(0);
    const installed = path.join(home, ".opencode", "bin", "opencode");
    expect(fs.existsSync(installed)).toBe(true);
    expect(execFileSync(installed, { encoding: "utf8" }).trim()).toBe("opencode-fixture");
    expect(fs.readFileSync(path.join(root, "curl-url"), "utf8").trim()).toBe(
      "https://github.com/anomalyco/opencode/releases/download/v9.9.9/opencode-linux-arm64.tar.gz",
    );
  });

  it("refuses to install when the checksum does not match", () => {
    const result = run(buildOpenCodeSandboxInstallCommand("9.9.9", { "linux-arm64": "0".repeat(64) }) + "true");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch for linux-arm64");
    expect(fs.existsSync(path.join(home, ".opencode", "bin", "opencode"))).toBe(false);
  });

  it("refuses targets that have no pinned checksum", () => {
    const result = run(buildOpenCodeSandboxInstallCommand("9.9.9", { "linux-x64": fixtureSha }) + "true");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no pinned checksum for linux-arm64");
    expect(fs.existsSync(path.join(root, "curl-url"))).toBe(false);
  });

  it("pins every linux release target and no longer pipes a remote script into a shell", () => {
    expect(Object.keys(OPENCODE_SANDBOX_SHA256).sort()).toEqual([
      "linux-arm64",
      "linux-arm64-musl",
      "linux-x64",
      "linux-x64-baseline",
      "linux-x64-baseline-musl",
      "linux-x64-musl",
    ]);
    for (const sha of Object.values(OPENCODE_SANDBOX_SHA256)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(SANDBOX_INSTALL_COMMAND).toContain(`/v${OPENCODE_SANDBOX_VERSION}/opencode-$OC_TARGET.tar.gz`);
    expect(SANDBOX_INSTALL_COMMAND).not.toMatch(/\|\s*(ba)?sh\b/);
  });
});
