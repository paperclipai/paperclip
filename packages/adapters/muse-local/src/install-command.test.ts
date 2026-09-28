import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MUSE_LAUNCHER_SHA256, MUSE_SANDBOX_INSTALL_COMMAND } from "./index.js";

// Runs the real install command with a fake `curl` that "downloads" the given
// launcher body, so the checksum gate is exercised without the network.
function runInstall(launcherBody: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-muse-install-"));
  const bin = path.join(root, "fakebin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, "launcher.sh"), launcherBody);
  // The fake curl copies the prepared launcher to the -o target.
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${root}/launcher.sh" "$2"; shift; fi; shift; done\n`, { mode: 0o755 });
  // Deny sudo so the command takes the per-user fallback.
  fs.writeFileSync(path.join(bin, "sudo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  let exitCode = 0;
  try {
    execFileSync("/bin/sh", ["-c", MUSE_SANDBOX_INSTALL_COMMAND], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      stdio: "pipe",
    });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? 1;
  }
  const installed = fs.existsSync(path.join(home, ".local", "bin", "muse"));
  fs.rmSync(root, { recursive: true, force: true });
  return { exitCode, installed };
}

describe("MUSE_SANDBOX_INSTALL_COMMAND", () => {
  it("pins the launcher by SHA-256", () => {
    expect(MUSE_LAUNCHER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(MUSE_SANDBOX_INSTALL_COMMAND).toContain(MUSE_LAUNCHER_SHA256);
  });

  it("refuses a launcher whose checksum does not match, and installs nothing", () => {
    const result = runInstall("#!/bin/sh\necho tampered\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.installed).toBe(false);
  });

  it("prefers a system-wide install and falls back to ~/.local/bin only without root or sudo", () => {
    expect(MUSE_SANDBOX_INSTALL_COMMAND).toContain("/usr/local/bin");
    expect(MUSE_SANDBOX_INSTALL_COMMAND).toContain("sudo -n true");
    expect(MUSE_SANDBOX_INSTALL_COMMAND).toContain('"$HOME/.local/bin"');
  });
});
