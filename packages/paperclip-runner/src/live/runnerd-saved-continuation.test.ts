import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
import { collectUntilTerminal } from "../drivers/codex/codex-app-server-driver.test-support.js";

it.each(["omitted", "null", "resolved"] as const)("retains a server-owned workspace yield through the actual Rust bridge (%s)", async form => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-saved-continuation-")), runId = "run-saved-workspace";
  const continuation = { kind: "same_agent", summary: "Continue with the prepared task repository.", idempotencyKey: "repository:task:receipt:run" };
  const report = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "The repository is staged; the requested verification continues.",
    completionClaim: { contractRevision: "1", objectiveSatisfied: false, criteria: [{ criterionId: "objective", status: "not_satisfied", evidenceRefs: [] }],
      remainingWork: [{ description: "Read the prepared repository and deliver its result.", blocksCompletion: true }] },
    evidence: [], verification: [], attentionRequests: [], artifacts: [],
    ...(form === "resolved" ? { continuation } : form === "null" ? { continuation: null } : {}) };
  const reportFile = join(root, "provider-report.json"), callLog = join(root, "provider-calls.txt");
  await writeFile(reportFile, JSON.stringify(report));
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(join(root, "home")), mkdir(workspace)]);
  const environment = { PATH: process.env.PATH, HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home"), LANG: "C.UTF-8" };
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider-state.json"), "--call-log", callLog, "--terminal-result-file", reportFile],
    stateDirectory: root, environment,
    prpIdentity: { runnerInstanceId: "runner-saved-workspace", environmentLeaseId: "lease-saved-workspace", runId, normalizedSessionId: "session-saved-workspace", turnId: "turn-saved-workspace", itemId: "item-saved-workspace" },
  });
  const dynamicToolHandler = vi.fn(async () => ({ run: { id: runId }, activeTask: { executionRunId: runId }, completionContinuation: continuation }));
  const completionFeedback = vi.fn(async () => "The saved repository continuation is accepted.");
  const driver = new CodexAppServerDriver({ approvalPolicy: "never", includeCollaborationModeInstructions: false, environment,
    taskEnvelope: createCodexTaskEnvelope({ objective: "Verify the prepared repository.", contractRevision: "1", criteria: [{ id: "objective", requirement: "Deliver the result." }], constraints: [] }),
    dynamicTools: [{ name: "get_task_context", description: "Read current task authority.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    dynamicToolHandler, completionFeedback, transportFactory: () => bundle.transport, requireProviderSessionIdentity: true });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  try {
    session = await driver.openSession({ runId, normalizedSessionId: "session-saved-workspace", workingDirectory: workspace });
    await session.startTurn({ message: { role: "user", text: "Continue with the prepared checkout." } });
    const events = await collectUntilTerminal(session.events());
    expect(completionFeedback).toHaveBeenCalledExactlyOnceWith({ ...report, continuation });
    expect(dynamicToolHandler).toHaveBeenCalledOnce();
    expect(events.filter(event => event.eventType === "run.result.proposed")).toHaveLength(1);
    expect(events.at(-1)?.eventType).toBe("turn.completed");
    expect((await session.snapshot()).semanticResult?.result).toEqual({ ...report, continuation });
    expect(await readFile(callLog, "utf8")).toContain("terminal-result:accepted");
    const journal = JSON.parse(await readFile(join(root, "control-plane/control-plane-state.json"), "utf8"));
    const terminals = journal.committedEvents.filter((event: { eventType: string }) => event.eventType === "run.terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].envelope.payload).toMatchObject({ runId, eventType: "run.terminal", payload: { runTerminalState: "succeeded", reportedWorkDisposition: "yielded" } });
  } finally {
    await session?.close();
    await bundle.transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
