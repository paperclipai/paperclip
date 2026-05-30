import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "hermes-paperclip-adapter/server";

async function writeFakeHermesCommand(commandPath: string, source: string) {
  await fs.writeFile(
    commandPath,
    `#!/usr/bin/env node
${source}
`,
    "utf8",
  );
  await fs.chmod(commandPath, 0o755);
}

describe("hermes execute", () => {
  it("does not fall through when a successful response mentions product quota blockers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-quota-prose-"));
    const commandPath = path.join(root, "hermes");
    const modelsLogPath = path.join(root, "models.log");

    await writeFakeHermesCommand(
      commandPath,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("hermes-test 0.0.0");
  process.exit(0);
}
const modelIndex = args.indexOf("-m");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "missing-model";
fs.appendFileSync(${JSON.stringify(modelsLogPath)}, model + "\\n");
console.log("Marked issue blocked with proof.");
console.log("Firestore quota exhausted: gRPC 8 RESOURCE_EXHAUSTED.");
console.log("GCP quota exceeded is a product blocker, not a model provider error.");
console.log("session_id: sess-quota-prose");
process.exit(0);
`,
    );

    const logs: string[] = [];
    const result = await execute({
      runId: "run-quota-prose",
      agent: {
        id: "agent-quota-prose",
        companyId: "company-1",
        name: "Hermes Quota Prose Agent",
        adapterConfig: {
          hermesCommand: commandPath,
          cwd: root,
          model: "deepseek/deepseek-v4-flash",
          provider: "openrouter",
          blueprintHermesModelLadder: [
            "deepseek/deepseek-v4-flash",
            "deepseek/deepseek-v4-pro",
          ],
          persistSession: false,
        },
      },
      runtime: {},
      config: {},
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);

    expect(result.errorMessage).toBeUndefined();
    expect(result.model).toBe("deepseek/deepseek-v4-flash");
    expect(result.summary).toContain("Firestore quota exhausted");
    expect(result.resultJson).toMatchObject({
      attempted_models: ["deepseek/deepseek-v4-flash"],
    });
    expect(logs.join("")).not.toContain("Falling through to deepseek/deepseek-v4-pro");
    expect(await fs.readFile(modelsLogPath, "utf8")).toBe("deepseek/deepseek-v4-flash\n");
  });

  it("falls through to the next configured model on generic retryable 429s", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-execute-"));
    const commandPath = path.join(root, "hermes");
    const modelsLogPath = path.join(root, "models.log");

    await writeFakeHermesCommand(
      commandPath,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("hermes-test 0.0.0");
  process.exit(0);
}
const modelIndex = args.indexOf("-m");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "missing-model";
fs.appendFileSync(${JSON.stringify(modelsLogPath)}, model + "\\n");
if (model === "arcee-ai/trinity-large-preview:free") {
  console.log("⚠️  API call failed (attempt 1/3): RateLimitError [HTTP 429]");
  console.log("🔌 Provider: openrouter  Model: arcee-ai/trinity-large-preview:free");
  console.log("📝 Error: HTTP 429: Too Many Requests.");
  console.log("API call failed after 3 retries: HTTP 429: Too Many Requests.");
  console.log("session_id: sess-rate-limited");
  process.exit(0);
}
console.log("Completed the assigned Paperclip issue.");
console.log("session_id: sess-success");
`,
    );

    const logs: string[] = [];
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Test Agent",
        adapterConfig: {
          hermesCommand: commandPath,
          cwd: root,
          model: "arcee-ai/trinity-large-preview:free",
          provider: "openrouter",
          blueprintHermesModelLadder: [
            "arcee-ai/trinity-large-preview:free",
            "z-ai/glm-5.1",
          ],
          persistSession: false,
        },
      },
      runtime: {},
      config: {},
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);

    expect(result.errorMessage).toBeUndefined();
    expect(result.model).toBe("z-ai/glm-5.1");
    expect(result.resultJson).toMatchObject({
      attempted_models: [
        "arcee-ai/trinity-large-preview:free",
        "z-ai/glm-5.1",
      ],
    });
    expect(logs.join("")).toContain("Falling through to z-ai/glm-5.1");
    expect(await fs.readFile(modelsLogPath, "utf8")).toBe(
      "arcee-ai/trinity-large-preview:free\nz-ai/glm-5.1\n",
    );
  });

  it("forwards onSpawn so Paperclip can record the child pid for orphan recovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-onspawn-"));
    const commandPath = path.join(root, "hermes");

    await writeFakeHermesCommand(
      commandPath,
      `
if (process.argv.includes("--version")) {
  console.log("hermes-test 0.0.0");
  process.exit(0);
}
console.log("Hermes child started");
console.log("session_id: sess-onspawn");
`,
    );

    let spawnedPid: number | null = null;
    const result = await execute({
      runId: "run-onspawn",
      agent: {
        id: "agent-onspawn",
        companyId: "company-1",
        name: "Hermes Spawn Agent",
        adapterConfig: {
          hermesCommand: commandPath,
          cwd: root,
          persistSession: false,
        },
      },
      runtime: {},
      config: {},
      onLog: async () => {},
      onSpawn: async ({ pid }) => {
        spawnedPid = pid;
      },
    } as never);

    expect(result.errorMessage).toBeUndefined();
    expect(typeof spawnedPid).toBe("number");
    expect((spawnedPid ?? 0) > 0).toBe(true);
  });

  it("stops the Hermes ladder immediately on shared OpenRouter free-pool limits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-shared-pool-"));
    const commandPath = path.join(root, "hermes");
    const modelsLogPath = path.join(root, "models.log");

    await writeFakeHermesCommand(
      commandPath,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("hermes-test 0.0.0");
  process.exit(0);
}
const modelIndex = args.indexOf("-m");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "missing-model";
fs.appendFileSync(${JSON.stringify(modelsLogPath)}, model + "\\n");
console.log("⚠️  API call failed (attempt 1/3): RateLimitError [HTTP 429]");
console.log("🔌 Provider: openrouter  Model: " + model);
console.log("📝 Error: HTTP 429: Rate limit exceeded: free-models-per-min.");
console.log("API call failed after 3 retries: HTTP 429: Rate limit exceeded: free-models-per-min.");
console.log("session_id: sess-shared-pool");
process.exit(0);
`,
    );

    const logs: string[] = [];
    const result = await execute({
      runId: "run-shared-pool",
      agent: {
        id: "agent-shared-pool",
        companyId: "company-1",
        name: "Hermes Shared Pool Agent",
        adapterConfig: {
          hermesCommand: commandPath,
          cwd: root,
          model: "arcee-ai/trinity-large-preview:free",
          provider: "openrouter",
          blueprintHermesModelLadder: [
            "arcee-ai/trinity-large-preview:free",
            "z-ai/glm-5.1",
            "openai/gpt-oss-120b:free",
          ],
          persistSession: false,
        },
      },
      runtime: {},
      config: {},
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);

    expect(result.model).toBe("arcee-ai/trinity-large-preview:free");
    expect(result.errorCode).toBe("rate_limited");
    expect(result.errorMessage).toContain("free-models-per-min");
    expect(result.resultJson).toMatchObject({
      attempted_models: ["arcee-ai/trinity-large-preview:free"],
    });
    expect(logs.join("")).toContain("Stopping Hermes ladder so outer fallback can take over");
    expect(logs.join("")).not.toContain("Falling through to z-ai/glm-5.1");
    expect(await fs.readFile(modelsLogPath, "utf8")).toBe("arcee-ai/trinity-large-preview:free\n");
  });

  it("returns a terminal failure when the ladder exhausts on a 404 model miss", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-404-"));
    const commandPath = path.join(root, "hermes");
    const modelsLogPath = path.join(root, "models.log");

    await writeFakeHermesCommand(
      commandPath,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("hermes-test 0.0.0");
  process.exit(0);
}
const modelIndex = args.indexOf("-m");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "missing-model";
fs.appendFileSync(${JSON.stringify(modelsLogPath)}, model + "\\n");
console.log("⚠️  API call failed (attempt 1/3): NotFoundError [HTTP 404]");
console.log("🔌 Provider: openrouter  Model: " + model);
console.log("📝 Error: HTTP 404: No endpoints found for " + model + ".");
console.log("❌ Non-retryable client error (HTTP 404). Aborting.");
console.log("session_id: sess-404");
process.exit(0);
`,
    );

    const result = await execute({
      runId: "run-404",
      agent: {
        id: "agent-404",
        companyId: "company-1",
        name: "Hermes 404 Agent",
        adapterConfig: {
          hermesCommand: commandPath,
          cwd: root,
          model: "stepfun/step-3.5-flash:free",
          provider: "openrouter",
          blueprintHermesModelLadder: ["stepfun/step-3.5-flash:free"],
          persistSession: false,
        },
      },
      runtime: {},
      config: {},
      onLog: async () => {},
    } as never);

    expect(result.errorCode).toBe("model_not_found");
    expect(result.errorMessage).toContain("No endpoints found");
    expect(result.resultJson).toMatchObject({
      attempted_models: ["stepfun/step-3.5-flash:free"],
    });
    expect(await fs.readFile(modelsLogPath, "utf8")).toBe("stepfun/step-3.5-flash:free\n");
  });

  it("never defaults back to a Claude model when Hermes config is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-default-"));
    const commandPath = path.join(root, "hermes");
    const modelsLogPath = path.join(root, "models.log");

    await writeFakeHermesCommand(
      commandPath,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("hermes-test 0.0.0");
  process.exit(0);
}
const modelIndex = args.indexOf("-m");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "missing-model";
fs.appendFileSync(${JSON.stringify(modelsLogPath)}, model + "\\n");
console.log("Used model " + model);
console.log("session_id: sess-default");
`,
    );

    const result = await execute({
      runId: "run-2",
      agent: {
        id: "agent-2",
        companyId: "company-1",
        name: "Hermes Default Agent",
        adapterConfig: {
          hermesCommand: commandPath,
          cwd: root,
          persistSession: false,
        },
      },
      runtime: {},
      config: {},
      onLog: async () => {},
    } as never);

    expect(result.model).toBe("openrouter/free");
    expect(await fs.readFile(modelsLogPath, "utf8")).toBe("openrouter/free\n");
  });
});
