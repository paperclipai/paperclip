import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AGY_INSTALLER_SHA256, SANDBOX_INSTALL_COMMAND } from "./index.js";

const execFileAsync = promisify(execFile);

describe("SANDBOX_INSTALL_COMMAND", () => {
  it("verifies the pinned installer checksum before executing it", () => {
    // The pin is a full SHA256 and the command checks the download against
    // it; a moving remote script is never piped straight into a shell.
    expect(AGY_INSTALLER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(SANDBOX_INSTALL_COMMAND).not.toContain("| bash");
    expect(SANDBOX_INSTALL_COMMAND).toContain(
      "curl -fsSL --compressed https://antigravity.google/cli/install.sh -o \"$agy_installer\"",
    );
    expect(SANDBOX_INSTALL_COMMAND).toContain(
      `echo "${AGY_INSTALLER_SHA256}  $agy_installer" | sha256sum -c -`,
    );
    expect(SANDBOX_INSTALL_COMMAND).toContain('bash "$agy_installer"');
    // The checksum/download failure propagates as the command's exit status.
    expect(SANDBOX_INSTALL_COMMAND).toContain('if [ "$agy_install_status" -ne 0 ]; then exit "$agy_install_status"; fi');
    // The PATH link step from the original command is preserved.
    expect(SANDBOX_INSTALL_COMMAND).toContain('ln -sf "$HOME/.local/bin/agy" /usr/local/bin/agy');
  });

  it("fails closed and never executes an installer whose checksum mismatches", async () => {
    const stubBin = await fs.mkdtemp(path.join(os.tmpdir(), "agy-install-stub-bin-"));
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-install-home-"));
    const bashMarker = path.join(stubBin, "bash-was-executed");
    try {
      // curl stub: serves a tampered installer to the -o target.
      await fs.writeFile(
        path.join(stubBin, "curl"),
        [
          "#!/bin/sh",
          "out=",
          'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done',
          'printf "tampered installer payload" > "$out"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      // bash stub: records that it was executed.
      await fs.writeFile(
        path.join(stubBin, "bash"),
        ["#!/bin/sh", `touch "${bashMarker}"`, ""].join("\n"),
        { mode: 0o755 },
      );

      const run = await execFileAsync("sh", ["-c", SANDBOX_INSTALL_COMMAND], {
        env: {
          ...process.env,
          PATH: `${stubBin}:${process.env.PATH ?? ""}`,
          HOME: fakeHome,
        },
      }).then(
        () => ({ exitCode: 0 }),
        (err: NodeJS.ErrnoException & { code?: number }) => ({ exitCode: err.code ?? 1 }),
      );

      expect(run.exitCode).not.toBe(0);
      const bashExecuted = await fs.stat(bashMarker).then(() => true).catch(() => false);
      expect(bashExecuted).toBe(false);
    } finally {
      await Promise.all([
        fs.rm(stubBin, { recursive: true, force: true }).catch(() => undefined),
        fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  });
});
