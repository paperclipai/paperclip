import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { testEnvironment } from "./test.js";

// Run the real SSH command builder, tar transfer, runtime layout, and teardown.
// Only the SSH endpoint and Pi binary are local fixture executables.
describe("pi remote environment provider configuration", () => {
  let fixtureDir: string;
  let workspace: string;
  let binaryDir: string;
  let configLog: string;
  let sshLog: string;
  let target: AdapterSshExecutionTarget;

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-fake-ssh-"));
    workspace = path.join(fixtureDir, "workspace");
    binaryDir = path.join(fixtureDir, "bin");
    configLog = path.join(fixtureDir, "config-paths.jsonl");
    sshLog = path.join(fixtureDir, "temporary-paths.jsonl");
    await fs.mkdir(workspace);
    await fs.mkdir(binaryDir);
    await fs.mkdir(path.join(fixtureDir, "remote-home"));
    await fs.writeFile(path.join(workspace, "user-file.txt"), "Keep this workspace intact.\n");
    await fs.writeFile(path.join(binaryDir, "ssh"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const command = process.argv[process.argv.length - 1];
if (process.env.PI_TEST_FAIL_CLEANUP === "1" && command.includes("/tmp/paperclip-pi-envtest-") && command.includes("-rf") && /\\brm\\b/.test(command)) {
  console.error("Simulated SSH disconnect before cleanup.");
  process.exit(255);
}
const remoteEnv = { ...process.env, HOME: process.env.PI_TEST_REMOTE_HOME };
const child = spawn("/bin/sh", ["-c", command], { env: remoteEnv, stdio: ["inherit", "pipe", "pipe"] });
let stdout = "";
child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.pipe(process.stderr);
child.on("close", (code) => {
  const directory = stdout.trim();
  if (/^\\/tmp\\/paperclip-pi-envtest-[A-Za-z0-9]{6}$/.test(directory)) {
    fs.appendFileSync(process.env.PI_TEST_SSH_LOG, JSON.stringify({ directory }) + "\\n");
  }
  if (code === 0 && process.env.PI_TEST_FAIL_UPLOAD === "1" && command.includes("tar -xf -")) {
    console.error("Simulated SSH failure after the provider file was uploaded.");
    process.exit(17);
  }
  process.exit(code || 0);
});
`, "utf8");
    await fs.writeFile(path.join(binaryDir, "pi"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
(async () => {
  const provider = process.argv[process.argv.indexOf("--provider") + 1];
  const model = process.argv[process.argv.indexOf("--model") + 1];
  if (process.env.PI_TEST_BARRIER) {
    fs.writeFileSync(path.join(process.env.PI_TEST_BARRIER, provider + ".ready"), "ready");
    const deadline = Date.now() + 5000;
    while (fs.readdirSync(process.env.PI_TEST_BARRIER).length < 2) {
      if (Date.now() >= deadline) throw new Error("Fake Pi parallel probe barrier timed out.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const configDir = process.env.PI_CODING_AGENT_DIR;
  const providers = JSON.parse(fs.readFileSync(path.join(configDir, "models.json"), "utf8")).providers;
  fs.appendFileSync(process.env.PI_TEST_CONFIG_LOG, JSON.stringify({ configDir, provider }) + "\\n");
  if (!providers[provider]?.models.some((entry) => entry.id === model) || providers[provider].apiKey !== "fake-" + provider) {
    throw new Error("The probe read another provider configuration.");
  }
  if (process.env.PI_TEST_FAIL_PROBE === "1") throw new Error("Simulated Pi hello failure.");
  console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, toolResults: [] }));
})().catch((error) => { console.error(error.message); process.exit(1); });
`, "utf8");
    await fs.chmod(path.join(binaryDir, "ssh"), 0o755);
    await fs.chmod(path.join(binaryDir, "pi"), 0o755);
    vi.stubEnv("PATH", `${binaryDir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("PI_TEST_REMOTE_HOME", path.join(fixtureDir, "remote-home"));
    vi.stubEnv("PI_TEST_SSH_LOG", sshLog);
    target = {
      kind: "remote", transport: "ssh", remoteCwd: workspace,
      spec: {
        host: "fixture.example.test", port: 22, username: "fixture",
        remoteCwd: workspace, remoteWorkspacePath: workspace,
        privateKey: null, knownHosts: null, strictHostKeyChecking: true,
      },
    };
  });

  afterEach(async () => {
    // Clean owned fixture directories even when a regression assertion fails.
    for (const directory of await createdRemoteDirectories()) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  async function createdRemoteDirectories(): Promise<string[]> {
    const content = await fs.readFile(sshLog, "utf8").catch(() => "");
    return content.trim().split("\n").filter(Boolean).map((line) => {
      const { directory } = JSON.parse(line) as { directory: string };
      if (!/^\/tmp\/paperclip-pi-envtest-[A-Za-z0-9]{6}$/.test(directory)) {
        throw new Error("Fixture received an unowned remote directory.");
      }
      return directory;
    });
  }

  async function probe(provider: string, extraEnv: Record<string, string> = {}) {
    return testEnvironment({
      companyId: "company-1", adapterType: "pi_local", executionTarget: target,
      config: {
        model: `${provider}/test-model`,
        env: {
          PATH: process.env.PATH ?? "", PI_TEST_CONFIG_LOG: configLog,
          PAPERCLIP_PI_PROVIDERS: JSON.stringify({
            [provider]: { apiKey: `fake-${provider}`, models: [{ id: "test-model" }] },
          }),
          ...extraEnv,
        },
      },
    });
  }

  async function expectRemoteCleanup(expectedCount: number): Promise<void> {
    const directories = await createdRemoteDirectories();
    expect(directories).toHaveLength(expectedCount);
    for (const directory of directories) await expect(fs.access(directory)).rejects.toThrow();
    expect(await fs.readFile(path.join(workspace, "user-file.txt"), "utf8")).toBe("Keep this workspace intact.\n");
    await expect(fs.access(path.join(workspace, ".paperclip-runtime"))).rejects.toThrow();
  }

  it.each([false, true])("removes remote provider files after a probe (failure=%s)", async (fail) => {
    const result = await probe("gateway", fail ? { PI_TEST_FAIL_PROBE: "1" } : {});
    expect(result.status).toBe(fail ? "fail" : "pass");
    await expectRemoteCleanup(1);
  });

  it("keeps parallel probes in the same workspace on separate provider configurations", async () => {
    const barrier = path.join(fixtureDir, "barrier");
    await fs.mkdir(barrier);
    const results = await Promise.all([
      probe("gateway-a", { PI_TEST_BARRIER: barrier }),
      probe("gateway-b", { PI_TEST_BARRIER: barrier }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
    const invocations = (await fs.readFile(configLog, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { configDir: string; provider: string });
    expect(new Set(invocations.map((entry) => entry.configDir)).size).toBe(2);
    expect(invocations.map((entry) => entry.provider).sort()).toEqual(["gateway-a", "gateway-b"]);
    await expectRemoteCleanup(2);
  });

  it("removes a partially uploaded remote provider file when staging fails", async () => {
    vi.stubEnv("PI_TEST_FAIL_UPLOAD", "1");
    await expect(probe("gateway")).rejects.toThrow("Simulated SSH failure");
    await expectRemoteCleanup(1);
  });

  it("reports cleanup failure without hiding completed hello checks", async () => {
    vi.stubEnv("PI_TEST_FAIL_CLEANUP", "1");
    const result = await probe("gateway");
    expect(result.status).toBe("warn");
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    const warning = result.checks.find((check) => check.code === "pi_remote_config_cleanup_failed");
    expect(warning?.level).toBe("warn");
    const directories = await createdRemoteDirectories();
    expect(directories).toHaveLength(1);
    expect(warning?.detail).toBe(directories[0]);
    // The failed cleanup really left a file; the warning tells the operator where.
    await expect(fs.access(path.join(directories[0], ".paperclip-runtime/pi/agentConfig/models.json"))).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(workspace, "user-file.txt"), "utf8")).toBe("Keep this workspace intact.\n");
  });
});
