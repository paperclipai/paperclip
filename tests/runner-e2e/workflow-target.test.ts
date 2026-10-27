import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const queuedSha = "a".repeat(40);
const advancedSha = "b".repeat(40);

async function resolveTarget(event: string, cadence: string, branch = "master") {
  const workflow = await readFile(new URL("../../.github/workflows/runner-full-stack-e2e.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Resolve requested repository branch to an immutable commit\n")[1]!.split("\n      - name:")[0]!;
  const script = step.split("        run: |\n")[1]!.replace(/^ {10}/gm, "");
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-workflow-target-"));
  try {
    const output = path.join(directory, "output");
    const result = spawnSync("bash", ["-c", `gh() { printf '%s\\n' "$MOCK_BRANCH_SHA"; }\n${script}`], {
      encoding: "utf8", env: { ...process.env, EVENT_NAME: event, EVAL_CADENCE: cadence,
        TARGET_BRANCH: branch, DEFAULT_BRANCH: "master", GITHUB_SHA: queuedSha,
        MOCK_BRANCH_SHA: advancedSha, GITHUB_OUTPUT: output, REPOSITORY: "paperclipai/paperclip" },
    });
    return { status: result.status, stderr: result.stderr,
      output: await readFile(output, "utf8").catch(() => "") };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe("paid workflow target authorization", () => {
  it.each([["schedule", "manual"], ["workflow_dispatch", "daily"], ["workflow_dispatch", "weekly"]])(
    "pins %s/%s to the queued revision when the branch advances", async (event, cadence) => {
      const result = await resolveTarget(event, cadence);
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toContain(`sha=${queuedSha}\n`);
      expect(result.output).not.toContain(advancedSha);
    });

  it("rejects custom bounded targets before emitting a commit", async () => {
    const result = await resolveTarget("workflow_dispatch", "daily", "development");
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
    expect(result.stderr).toContain("default-branch commit");
  });

  it("still resolves explicit manual targets at authorization time", async () => {
    const result = await resolveTarget("workflow_dispatch", "manual", "development");
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(`sha=${advancedSha}\n`);
    expect(result.output).toContain("ref=refs/heads/development\n");
  });
});
