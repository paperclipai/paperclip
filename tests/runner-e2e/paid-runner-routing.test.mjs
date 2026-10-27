import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const workflow = await readFile(new URL("../../.github/workflows/runner-full-stack-e2e.yml", import.meta.url), "utf8");
const step = workflow.split("      - name: Select paid test runner\n")[1]?.split("\n  target_lock:")[0];
if (!step?.includes("        run: |\n")) throw new Error("Missing actual workflow runner selection");
const script = step.split("        run: |\n")[1].split("\n").map(line => line.replace(/^          /, "")).join("\n");

async function select(overrides) {
  const root = await mkdtemp(path.join(tmpdir(), "eval-runner-routing-"));
  try {
    const output = path.join(root, "outputs");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: {
      PATH: process.env.PATH, GITHUB_OUTPUT: output, AWS_PAID_RUNNER_ENABLED: "true",
      EVENT_NAME: "workflow_dispatch", EVAL_CADENCE: "manual", REPOSITORY_PRIVATE: "false", ...overrides,
    } });
    const saved = await readFile(output, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    return { ...result, outputs: Object.fromEntries(saved.trim().split("\n").filter(Boolean).map(line => {
      const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)];
    })) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

it.each([
  { EVENT_NAME: "schedule" },
  { EVAL_CADENCE: "daily" },
  { EVAL_CADENCE: "weekly" },
])("routes bounded $EVENT_NAME/$EVAL_CADENCE campaigns to standard hosted compute despite the AWS switch", async trigger => {
  const result = await select(trigger);
  expect(result.status).toBe(0);
  expect(result.outputs).toMatchObject({ runner: "ubuntu-latest", playwright_channel: "" });
});

it.each(["true", "", "unknown"])("refuses bounded campaigns when repository privacy is %s", async REPOSITORY_PRIVATE => {
  const result = await select({ EVAL_CADENCE: "daily", REPOSITORY_PRIVATE });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("require a public repository");
  expect(result.outputs).toEqual({});
});

it("preserves the explicit manual AWS and GitHub options", async () => {
  const aws = await select({ REPOSITORY_PRIVATE: "true" });
  expect(aws.status).toBe(0);
  expect(aws.outputs).toMatchObject({ runner: "runs-on/fleet=paperclip-public-pr-x64/env=public-ci", playwright_channel: "chrome" });
  const hosted = await select({ AWS_PAID_RUNNER_ENABLED: "false" });
  expect(hosted.status).toBe(0);
  expect(hosted.outputs).toMatchObject({ runner: "ubuntu-latest", playwright_channel: "" });
});
