import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export function codexUserNamespaceProfile(binary: string) {
  // Exact executable attachment only; no wildcard or policy syntax from paths.
  if (!path.posix.isAbsolute(binary) || !/^[/A-Za-z0-9_.@+\-]+$/.test(binary)) {
    throw new Error("Unsafe Codex executable path for CI AppArmor profile");
  }
  const name = `paperclip-e2e-codex-${createHash("sha256").update(binary).digest("hex").slice(0, 16)}`;
  return `abi <abi/4.0>,\ninclude <tunables/global>\nprofile ${name} "${binary}" flags=(unconfined) {\n  userns,\n}\n`;
}

/** Ubuntu CI requires an explicit userns grant for Codex's filesystem sandbox.
 * Keep the global AppArmor restriction and Codex's workspace policy enabled.
 * This is only used on the protected workflow's disposable Linux runners.
 */
export async function prepareCodexCiSandbox(repositoryRoot: string, temporaryRoot: string) {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") return;
  const restricted = await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8")
    .catch(() => "0");
  if (restricted.trim() !== "1") return;
  const runnerRequire = createRequire(path.join(repositoryRoot, "packages/paperclip-runner/package.json"));
  const acpRequire = createRequire(runnerRequire.resolve("@agentclientprotocol/codex-acp/package.json"));
  const codexRequire = createRequire(acpRequire.resolve("@openai/codex/package.json"));
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!arch) throw new Error("Unsupported Codex CI architecture");
  const platformPackage = codexRequire.resolve(`@openai/codex-linux-${arch}/package.json`);
  const triple = arch === "x64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl";
  const binary = await realpath(path.join(path.dirname(platformPackage), "vendor", triple, "bin", "codex"));
  const profilePath = path.join(temporaryRoot, "codex-userns.apparmor");
  await writeFile(profilePath, codexUserNamespaceProfile(binary), { mode: 0o600 });
  // sudo is noninteractive and bounded. Failure is a preflight error, before any model invocation.
  execFileSync("sudo", ["-n", "apparmor_parser", "-r", profilePath], { timeout: 15_000, stdio: "pipe" });
  const probeHome = path.join(temporaryRoot, "codex-sandbox-probe");
  await mkdir(probeHome, { mode: 0o700 });
  execFileSync(binary, [
    "sandbox", "--permission-profile", "paperclip-e2e-probe",
    "-c", 'permissions.paperclip-e2e-probe.filesystem={":root"="read"}',
    "-c", "permissions.paperclip-e2e-probe.network.enabled=false",
    "-C", temporaryRoot, "--", "/bin/true",
  ], {
    cwd: temporaryRoot,
    env: { PATH: process.env.PATH, CODEX_HOME: probeHome },
    timeout: 15_000,
    stdio: "pipe",
  });
}
