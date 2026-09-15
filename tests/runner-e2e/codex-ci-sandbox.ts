import { execFileSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** Probe the existing Linux sandbox before spending provider credentials.
 * Host policy is provisioned by the trusted workflow, never by target test code.
 */
export async function prepareCodexCiSandbox(
  repositoryRoot: string,
  temporaryRoot: string,
) {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true")
    return;
  const runnerRequire = createRequire(
    path.join(repositoryRoot, "packages/paperclip-runner/package.json"),
  );
  const acpRequire = createRequire(
    runnerRequire.resolve("@agentclientprotocol/codex-acp/package.json"),
  );
  const codexRequire = createRequire(
    acpRequire.resolve("@openai/codex/package.json"),
  );
  const arch =
    process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!arch) throw new Error("Unsupported Codex CI architecture");
  const platformPackage = codexRequire.resolve(
    `@openai/codex-linux-${arch}/package.json`,
  );
  const triple =
    arch === "x64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl";
  const binary = await realpath(
    path.join(path.dirname(platformPackage), "vendor", triple, "bin", "codex"),
  );
  const probeHome = path.join(temporaryRoot, "codex-sandbox-probe");
  await mkdir(probeHome, { mode: 0o700 });
  try {
    execFileSync(
      binary,
      [
        "sandbox",
        "--permission-profile",
        "paperclip-e2e-probe",
        "-c",
        'permissions.paperclip-e2e-probe.filesystem={":root"="read"}',
        "-c",
        "permissions.paperclip-e2e-probe.network.enabled=false",
        "-C",
        temporaryRoot,
        "--",
        "/bin/true",
      ],
      {
        cwd: temporaryRoot,
        env: { PATH: process.env.PATH, CODEX_HOME: probeHome },
        timeout: 15_000,
        stdio: "pipe",
      },
    );
  } catch (error) {
    throw new Error(
      "Codex sandbox preflight failed. The trusted CI runner must provision its user-namespace policy before paid tests run.",
      { cause: error },
    );
  }
}
