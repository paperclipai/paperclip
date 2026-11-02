import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquireAcpxProviderLifetimeLease } from "./codex-credentials.js";
import { resolveAcpxRuntimeRoot } from "./recovery-identity.js";
import { confirmAntigravityProbeNativeRetirement } from "./antigravity-probe-retirement.js";

it.skipIf(process.platform === "win32")("retains native cleanup until the real descendant releases its inherited kernel quorum", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-probe-quorum-"));
  const home = join(await resolveAcpxRuntimeRoot(root, "probe-session"), "antigravity-home", "antigravity-acp");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lease = await acquireAcpxProviderLifetimeLease({ agentHomeDirectory: home });
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    detached: true, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore", ...lease.lifetimeFenceFds],
  });
  const closed = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let retirement: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
    await lease.close();
    let retired = false;
    retirement = confirmAntigravityProbeNativeRetirement(root, "probe-session").then(() => { retired = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(retired).toBe(false);
    expect(child.exitCode).toBeNull();
    expect((await stat(home)).isDirectory()).toBe(true);
    child.kill("SIGKILL");
    await closed;
    await retirement;
    expect(retired).toBe(true);
    const successor = await acquireAcpxProviderLifetimeLease({ agentHomeDirectory: home });
    await successor.close();
  } finally {
    child.kill("SIGKILL");
    await closed;
    await lease.close();
    await retirement;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
