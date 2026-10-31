import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { appendPrivateAttemptDiagnostic, privateAttemptDiagnostic } from "./private-attempt-diagnostic.js";
it("projects only fixed outcomes from private result, run and carrier evidence", () => {
  const diagnostic = privateAttemptDiagnostic({ stage: "seal-original", result: { status: "failed", error: "Actual new native task reads inherited project context: private-value", runIds: ["private-id"] },
    error: new Error("Credential-contaminated original evidence cannot be retained"), evidence: { leaks: [{ file: "private-path", reason: "zip inspection exceeded its expanded-byte bound" }] },
    observation: { observation: { leadId: "lead", state: { futureWorker: { id: "future" }, activeRunId: "held" }, runs: [{ agentId: "lead", status: "succeeded" }, { agentId: "future", status: "running" }, { id: "held", status: "timed_out" }], reply: "private-value" } } });
  expect(diagnostic).toMatchObject({ finalization: "credential-contamination", phase: "future-work-timeout", runs: 3, source: "succeeded", future: "running", held: "timed_out", carrier: "zip-byte-bound", runStatusCounts: expect.objectContaining({ succeeded: 1, running: 1, timed_out: 1 }) });
  expect(JSON.stringify(diagnostic)).not.toMatch(/private-value|private-id|private-path/);
});
it("never copies unknown error, stage, failure or status text", () => {
  expect(JSON.stringify(privateAttemptDiagnostic({ stage: "private-value", result: { status: "private-value", failureClass: "private-value", error: "private-value" }, error: new Error("private-value") }))).not.toContain("private-value");
});
it("writes one closed variable to the actual owned runner environment file and rejects symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "closed-eval-diagnostic-"));
  try {
    const commands = path.join(root, "_runner_file_commands"); await mkdir(commands); const file = path.join(commands, "set_env_test"); await writeFile(file, "");
    const env = { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, GITHUB_ENV: file };
    await appendPrivateAttemptDiagnostic({ stage: "execution", error: new Error("private-value") }, env);
    const text = await readFile(file, "utf8"); expect(text).toMatch(/^PAPERCLIP_E2E_CLOSED_DIAGNOSTIC_V1=\{/); expect(text).not.toContain("private-value"); expect(text.trim().split("\n")).toHaveLength(1);
    await symlink(file, path.join(commands, "set_env_symlink"));
    await expect(appendPrivateAttemptDiagnostic({ stage: "execution" }, { ...env, GITHUB_ENV: path.join(commands, "set_env_symlink") })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
