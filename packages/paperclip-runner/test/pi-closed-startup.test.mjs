import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Explicit package-root and daemon opt-in: this exercises built artifacts, never
// downloads a provider, submits a prompt, or inherits ambient credentials.
if (process.argv[2] === "--pi-no-key-probe") {
  const [packageRoot, daemon, root] = process.argv.slice(3);
  const { createCapabilityRunnerdCodexTransport } = await import(pathToFileURL(join(packageRoot, "dist/live/runnerd-codex-transport.js")));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const evidence = []; const started = performance.now();
  const bundle = createCapabilityRunnerdCodexTransport({
    provider: "acpx", acpxAgent: "pi", acpxCandidateProfile: "pi", acpxPermissionMode: "deny-all",
    runnerBinary: daemon, stateDirectory: join(root, "state"),
    environment: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    onEvidence: value => evidence.push(value),
  });
  let error = null; let settledMs;
  try {
    await bundle.transport.request("initialize", { clientInfo: { name: "pi-closed-startup-regression", version: "1" } });
    await bundle.transport.request("thread/start", {
      cwd: workspace, model: "openrouter/deepseek/deepseek-v4-flash-0731",
      baseInstructions: "Credential-free admission probe. No prompt is submitted.",
      permissions: "paperclip-runner-workspace-read-only", dynamicTools: [],
    });
  } catch (failure) { error = String(failure); }
  finally { settledMs = Math.round(performance.now() - started); await bundle.transport.close(); }
  await writeFile(join(root, "report.json"), JSON.stringify({ error, settledMs, durationMs: Math.round(performance.now() - started), evidence }), { mode: 0o600 });
} else {
  const packageRoot = process.env.PAPERCLIP_TEST_PI_STARTUP_PACKAGE_ROOT;
  const daemon = process.env.PAPERCLIP_TEST_PI_STARTUP_RUNNER_BINARY;
  test("closed Pi Runner startup rejects admission and closes without a prompt", {
    skip: !packageRoot || !daemon, timeout: 60_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-closed-startup-"));
    await mkdir(join(root, "home"));
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--pi-no-key-probe", packageRoot, daemon, root], {
        env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = ""; child.stdout.resume(); child.stderr.on("data", chunk => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGTERM"), 55_000);
      try {
        const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        assert.equal(exitCode, 0, stderr);
      } finally { clearTimeout(timer); }
      const report = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
      assert.match(report.error, /session\.open failed/);
      assert.match(report.error, /retryable=false, classification=session_ensure_failed/);
      assert.doesNotMatch(report.error, /timed out/);
      assert.ok(report.settledMs < 30_000, `session.open took ${report.settledMs} ms`);
      assert.ok(report.evidence.some(item => item.runnerExited === true && item.runnerExitCode === 0));
      for (const item of report.evidence) assert.deepEqual(item.childEnvironmentKeys, ["LANG", "PATH"]);
      const state = JSON.parse(await readFile(join(root, "state/runner/acpx-provider-state.json"), "utf8"));
      assert.equal(state.descriptor.agent, "pi"); assert.equal(state.descriptor.agentRuntimeVersion, "0.84.2");
      assert.equal(state.activeTurnId, null); assert.equal(state.identity, null);
      assert.equal(state.providerExitUnconfirmed, false);
      console.log(JSON.stringify({ settledMs: report.settledMs, durationMs: report.durationMs, credentials: "none", promptCalls: 0 }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
