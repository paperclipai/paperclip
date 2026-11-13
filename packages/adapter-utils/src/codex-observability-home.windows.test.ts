import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE } from "@paperclipai/shared";
import { buildProviderObservabilityLaunch } from "./agent-observability.js";
import { prepareAcpxCodexObservabilityHome } from "./codex-observability-home.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), `paperclip-ai-${randomUUID()}-${randomUUID()}-`));
  roots.push(root);
  const home = path.join(root, "provider");
  await mkdir(home);
  await writeFile(path.join(home, "auth.json"), '{"OPENAI_API_KEY":"synthetic-not-a-real-key"}');
  await writeFile(path.join(home, "config.toml"), "");
  const agentId = randomUUID();
  const launch = buildProviderObservabilityLaunch({
    companyId: randomUUID(), agentId, revision: "revision", compatibilityKey: "a".repeat(64), enabled: false,
    capture: { ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE }, kind: "codex",
  });
  return { home, agentId, launch };
}

it.skipIf(process.platform !== "win32")("keeps Windows SQLite paths short and preserves account, agent and settings isolation", async () => {
  const { home, agentId, launch } = await fixture();
  const prepared = await prepareAcpxCodexObservabilityHome(home, launch, agentId);
  expect(path.join(prepared, "state_5.sqlite-wal").length).toBeLessThan(260);
  const repeated = await prepareAcpxCodexObservabilityHome(home, launch, agentId);
  const otherAgent = await prepareAcpxCodexObservabilityHome(home, launch, randomUUID());
  const otherSettings = await prepareAcpxCodexObservabilityHome(home, { ...launch, compatibilityKey: "b".repeat(64) }, agentId);
  expect(repeated).toBe(prepared);
  expect(otherAgent).not.toBe(prepared); expect(otherSettings).not.toBe(prepared);
  expect(await realpath(path.join(prepared, "sessions"))).toBe(await realpath(path.join(home, "sessions")));
  await writeFile(path.join(prepared, "sessions", "saved.jsonl"), "saved conversation");
  expect(await readFile(path.join(otherSettings, "sessions", "saved.jsonl"), "utf8")).toBe("saved conversation");
  await writeFile(path.join(prepared, "auth.json"), "refreshed synthetic credential");
  expect(await readFile(path.join(otherSettings, "auth.json"), "utf8")).toBe("refreshed synthetic credential");
});

const binary = process.env.PAPERCLIP_TEST_CODEX_BINARY;
it("retains the existing layout for short homes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pc-otel-")); roots.push(home);
  await writeFile(path.join(home, "auth.json"), "synthetic credential");
  const { launch } = await fixture();
  const prepared = await prepareAcpxCodexObservabilityHome(home, { ...launch, compatibilityKey: "version" }, "agent");
  expect(prepared).toBe(path.join(home, "paperclip-observability", "agent", "version"));
});

it.skipIf(process.platform !== "win32" || !binary)("initializes the real Codex SQLite runtime in a managed observability home", async () => {
  const { home, agentId, launch } = await fixture();
  const prepared = await prepareAcpxCodexObservabilityHome(home, launch, agentId);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary!, ["app-server"], {
      env: { ...process.env, CODEX_HOME: prepared }, cwd: home, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", ready = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
    child.stdout.on("data", data => {
      stdout += data;
      if (stdout.split("\n").some(line => { try { const response = JSON.parse(line); return response.id === 1 && response.result; } catch { return false; } })) {
        ready = true; child.kill();
      }
    });
    child.stderr.on("data", data => { stderr += data; });
    child.stdin.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (ready) resolve(); else reject(new Error(`Codex initialization failed (exit ${code}, timeout ${timedOut}): ${stderr}`));
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "paperclip-sqlite-regression", version: "1" } } }) + "\n");
  });
}, 15_000);
