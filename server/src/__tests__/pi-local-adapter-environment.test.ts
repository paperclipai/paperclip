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

  it("resolves PAPERCLIP_PI_PROVIDERS during verification so gateway models pass the probe", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-pi-local-providers-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    // A pi shim that only lists the llm2 model when the managed models.json is
    // materialized (i.e. PI_CODING_AGENT_DIR points at it). Without provider
    // injection, --list-models fails and the hello probe would too.
    const commandPath = path.join(binDir, "pi");
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  const fs = require("node:fs");
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (dir && fs.existsSync(dir + "/models.json")) {
    console.log("provider  model");
    console.log("llm2      qwen3.8-27b-w4a16");
    process.exit(0);
  }
  console.error("No models available.");
  process.exit(1);
}
console.log(JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }], usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } }, toolResults: [] }));
`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    const previousProviders = process.env.PAPERCLIP_PI_PROVIDERS;
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify({
      llm2: {
        name: "node6 front door",
        baseUrl: "https://litellm.example.com/v1",
        apiKey: "test-key",
        models: [{ id: "qwen3.8-27b-w4a16" }],
      },
    });

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "pi_local",
        config: {
          command: "pi",
          cwd,
          model: "llm2/qwen3.8-27b-w4a16",
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "pi_models_discovered")).toBe(true);
      expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    } finally {
      if (previousProviders === undefined) delete process.env.PAPERCLIP_PI_PROVIDERS;
      else process.env.PAPERCLIP_PI_PROVIDERS = previousProviders;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
