import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-pi-local/server";

async function writeFakePiCommand(
  binDir: string,
  mode: "success" | "stale-package" | "managed-config" | "managed-config-failure",
): Promise<void> {
  const commandPath = path.join(binDir, "pi");
  if (mode === "managed-config" || mode === "managed-config-failure") {
    await fs.writeFile(commandPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const configDir = process.env.PI_CODING_AGENT_DIR;
fs.appendFileSync(process.env.PI_TEST_CONFIG_LOG, JSON.stringify({ configDir, discovery: process.argv.includes("--list-models") }) + "\\n");
let providers = {};
try { providers = JSON.parse(fs.readFileSync(path.join(configDir, "models.json"), "utf8")).providers; } catch {}
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  for (const [provider, config] of Object.entries(providers)) {
    for (const model of config.models || []) console.log(provider + "  " + model.id);
  }
  process.exit(0);
}
const provider = process.argv[process.argv.indexOf("--provider") + 1];
const model = process.argv[process.argv.indexOf("--model") + 1];
if (!providers[provider]?.models.some((entry) => entry.id === model) || ${JSON.stringify(mode === "managed-config-failure")}) {
  console.error("Unknown provider or fake probe failure.");
  process.exit(1);
}
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }], usage: { input: 1, output: 1, cost: { total: 0 } } }, toolResults: [] }));
`, "utf8");
    await fs.chmod(commandPath, 0o755);
    return;
  }
  const script =
    mode === "success"
      ? `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("openai    gpt-4.1-mini");
  process.exit(0);
}
console.log(JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } }
  },
  toolResults: []
}));
`
      : `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.error("npm error 404 'pi-driver@*' is not in this registry.");
  process.exit(1);
}
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("pi_local environment diagnostics", () => {
  it.each(["managed-config", "managed-config-failure"] as const)(
    "uses the run provider config for discovery and the %s probe, then removes it",
    async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-provider-probe-"));
      const binDir = path.join(root, "bin");
      const cwd = path.join(root, "workspace");
      const staticDir = path.join(root, "static-agent-config");
      const configLog = path.join(root, "config-paths.jsonl");
      try {
        await fs.mkdir(binDir);
        await fs.mkdir(cwd);
        await fs.mkdir(staticDir);
        await fs.writeFile(path.join(staticDir, "models.json"), '{"providers":{}}\n');
        await writeFakePiCommand(binDir, mode);
        const result = await testEnvironment({
          companyId: "company-1",
          adapterType: "pi_local",
          config: {
            command: "pi",
            cwd,
            model: "gateway/test-model",
            env: {
              PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
              PI_CODING_AGENT_DIR: staticDir,
              PI_TEST_CONFIG_LOG: configLog,
              PAPERCLIP_PI_PROVIDERS: JSON.stringify({
                gateway: { apiKey: "not-needed", models: [{ id: "test-model" }] },
              }),
            },
          },
        });
        expect(result.status).toBe(mode === "managed-config" ? "pass" : "fail");
        expect(result.checks.some((check) => check.code === "pi_models_discovered")).toBe(true);
        expect(result.checks.some((check) => check.code === "pi_model_configured")).toBe(true);
        expect(result.checks.some((check) => check.code === "pi_model_not_found")).toBe(false);
        const invocations = (await fs.readFile(configLog, "utf8")).trim().split("\n")
          .map((line) => JSON.parse(line) as { configDir: string; discovery: boolean });
        expect(invocations.some((entry) => entry.discovery)).toBe(true);
        expect(invocations.some((entry) => !entry.discovery)).toBe(true);
        const configDirs = [...new Set(invocations.map((entry) => entry.configDir))];
        expect(configDirs).toHaveLength(1);
        expect(configDirs[0]).not.toBe(staticDir);
        await expect(fs.access(configDirs[0])).rejects.toThrow();
        expect(await fs.readFile(path.join(staticDir, "models.json"), "utf8")).toBe('{"providers":{}}\n');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("passes a hello probe when model discovery and execution succeed", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-pi-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakePiCommand(binDir, "success");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        cwd,
        model: "openai/gpt-4.1-mini",
        env: {
          OPENAI_API_KEY: "test-key",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "pi_models_discovered")).toBe(true);
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("surfaces stale configured package installs with a targeted hint", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-pi-local-stale-package-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakePiCommand(binDir, "stale-package");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        cwd,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    const stalePackageCheck = result.checks.find((check) => check.code === "pi_package_install_failed");
    expect(stalePackageCheck?.level).toBe("warn");
    expect(stalePackageCheck?.hint).toContain("Remove `npm:pi-driver`");
    await fs.rm(root, { recursive: true, force: true });
  });
});
