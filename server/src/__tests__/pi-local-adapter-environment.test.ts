import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-pi-local/server";

async function writeFakePiCommand(binDir: string, mode: "success" | "stale-package"): Promise<void> {
  const commandPath = path.join(binDir, "pi");
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

async function writeProviderAwareFakePiCommand(binDir: string, seenDirFile: string): Promise<void> {
  const commandPath = path.join(binDir, "pi");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.PI_CODING_AGENT_DIR || "";
fs.writeFileSync(${JSON.stringify(seenDirFile)}, dir);
let providers = {};
try { providers = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")).providers || {}; } catch {}
const ids = Object.entries(providers).flatMap(([name, p]) => (p.models || []).map((m) => name + "/" + m.id));
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  for (const id of ids) console.log(id.replace("/", "  "));
  process.exit(0);
}
const provider = process.argv[process.argv.indexOf("--provider") + 1];
const model = process.argv[process.argv.indexOf("--model") + 1];
if (!ids.includes(provider + "/" + model)) {
  console.error("Unknown provider " + provider);
  process.exit(1);
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
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("pi_local environment diagnostics", () => {
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

  it("checks custom providers from PAPERCLIP_PI_PROVIDERS the same way a run does", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-pi-local-providers-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const staticAgentDir = path.join(root, "static-agent");
    const seenDirFile = path.join(root, "seen-agent-dir");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(staticAgentDir, { recursive: true });
    await writeProviderAwareFakePiCommand(binDir, seenDirFile);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        cwd,
        model: "gateway/fast-model",
        env: {
          PI_CODING_AGENT_DIR: staticAgentDir,
          PAPERCLIP_PI_PROVIDERS: JSON.stringify({
            gateway: { baseUrl: "https://gateway.example/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "fast-model" }] },
          }),
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.checks.find((check) => check.code === "pi_model_not_found")).toBeUndefined();
    expect(result.checks.some((check) => check.code === "pi_model_configured")).toBe(true);
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    expect(result.status).toBe("pass");
    const preparedDir = await fs.readFile(seenDirFile, "utf8");
    expect(preparedDir).not.toBe(staticAgentDir);
    await expect(fs.stat(preparedDir)).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});
