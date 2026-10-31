import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { appendPrivateAttemptDiagnostic, privateAttemptDiagnostic, readPrivateAttemptObservation } from "./private-attempt-diagnostic.js";
import { canonicalProviderEventsFromOpenCodePart } from "../../packages/paperclip-runner/src/provider-events.js";
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
it("counts a finish from the actual OpenCode event producer and recovers the pre-scan phase", () => {
  const sourceEvents = ["pending", "running"].flatMap(status => canonicalProviderEventsFromOpenCodePart({ id: "private-call", type: "tool", tool: "paperclip_paperclip_finish", state: { status, input: {} } }));
  const diagnostic = privateAttemptDiagnostic({ stage: "package-original", result: { error: "Secret leak in persisted Paperclip home state at private-path" },
    observation: { sourceEvents, persistedState: { scanError: "private-error", originalResult: { error: "Canonical project-defaults turn settles: private-value" } } } });
  expect(diagnostic).toMatchObject({ phase: "canonical-turn-timeout", privacy: { persistedState: true }, sourceProgress: { tools: { paperclip_finish: { started: 1, progressed: 1, completed: 0 }, other: { started: 0, completed: 0 } } } });
  expect(JSON.stringify(diagnostic)).not.toMatch(/private-(?:call|path|error|value)/);
});
it("distinguishes an unfinished source tool and preserves a timeout hidden by privacy finalization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "closed-eval-progress-"));
  try {
    const snapshots = path.join(root, "snapshots"); await mkdir(snapshots);
    await writeFile(path.join(snapshots, "chat-catalog-observation.json"), JSON.stringify({ observation: { leadId: "private-lead", runs: [{ id: "private-run", agentId: "private-lead", status: "running" }] } }));
    await writeFile(path.join(snapshots, "chat-catalog-runs.json"), JSON.stringify([
      { runId: "private-other", events: [{ eventType: "run.result.proposed" }] },
      { runId: "private-run", events: [
        { payload: { prpEvent: { eventType: "turn.started" } } },
        { payload: { prpEvent: { eventType: "tool.execution.started", payload: { name: "paperclip_call_api", output: "private-value" } } } },
        { payload: { prpEvent: { eventType: "tool.execution.started", payload: { name: "private-tool" } } } },
        { payload: { prpEvent: { eventType: "tool.execution.completed", payload: { name: "private-tool" } } } },
      ] },
    ]));
    await writeFile(path.join(snapshots, "diagnostic-privacy.json"), JSON.stringify({ originalResult: { error: "Canonical project-defaults turn settles: private-value" }, issues: [{ file: "private-path" }] }));
    const diagnostic = privateAttemptDiagnostic({ stage: "package-original", result: { failureClass: "secret_leak" },
      error: new Error("Secret leak in snapshots/private.json: exact secret value"), observation: await readPrivateAttemptObservation(root) });
    expect(diagnostic).toMatchObject({ phase: "canonical-turn-timeout", finalization: "sanitized-text-leak", privacy: { reporter: 1, packaging: "snapshot" },
      sourceProgress: { events: 4, turns: 1, finishProposals: 0, tools: { paperclip_call_api: { started: 1, completed: 0 }, other: { started: 1, completed: 1 } } } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-(?:lead|run|value|path|tool|other)/);
    await rm(path.join(snapshots, "chat-catalog-runs.json"));
    const external = path.join(root, "outside.json"); await writeFile(external, JSON.stringify([{ runId: "private-run", events: [{ eventType: "run.result.proposed" }] }]));
    await symlink(external, path.join(snapshots, "chat-catalog-runs.json"));
    expect(privateAttemptDiagnostic({ stage: "execution", observation: await readPrivateAttemptObservation(root) }).sourceProgress.events).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
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
