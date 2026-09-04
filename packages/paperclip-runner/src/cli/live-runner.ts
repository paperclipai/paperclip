#!/usr/bin/env node
import { resolve } from "node:path";

import {
  CapabilityLiveSessionService,
  type CapabilityLiveSession,
} from "../live/live-session.js";

interface CliOptions {
  json: boolean;
  workingDirectory: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false, workingDirectory: process.cwd() };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") continue;
    if (value === "--json") options.json = true;
    else if (value === "--working-directory") {
      const directory = args[++index];
      if (!directory) throw new Error("--working-directory requires a path");
      options.workingDirectory = resolve(directory);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function operationRevision(session: CapabilityLiveSession): number | null {
  const result = session.snapshot().evidence.findLast((entry) => entry.kind === "tool_result")?.data.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  return typeof result.stateRevision === "number" ? result.stateRevision : null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const service = new CapabilityLiveSessionService({
    transportOptions: {
      onDiagnostic: (message) => process.stderr.write(`[capability runnerd] ${message}\n`),
    },
  });
  let session: CapabilityLiveSession | null = null;
  try {
    session = await service.create({
      workingDirectory: options.workingDirectory,
      turnTimeoutMs: 180_000,
    });
    const first = await session.sendMessage([
      "Call report_progress exactly once with idempotencyKey capability-live-smoke-1",
      "and body 'Real Codex changed mock state through ControlPlanePort.'.",
      "After the tool returns, reply with the exact stateRevision from its typed result.",
      "Do not call any other tool.",
    ].join(" "));
    const providerThreadId = first.snapshot.providerThreadId;
    const firstRunnerPid = first.snapshot.process?.runnerPid ?? null;
    const revision = operationRevision(session);
    await session.reconnect();
    const reconnected = session.snapshot();
    const second = await session.sendMessage(
      "Without calling another tool, confirm that the prior typed result changed mock state and repeat its stateRevision.",
    );
    const beforeShutdown = session.snapshot();
    const comment = session.mockState().comments.at(-1);
    await service.shutdown(session.id, "Capability live smoke complete");
    const afterShutdown = session.snapshot();
    const assertions = {
      realRunnerdStarted: beforeShutdown.process?.runnerPid !== null,
      realCodexStarted: beforeShutdown.process?.codexPid !== null,
      sameProviderThread: second.snapshot.providerThreadId === providerThreadId,
      reconnectStartedNewRunner:
        firstRunnerPid !== null && reconnected.process?.runnerPid !== firstRunnerPid,
      reconnectReapedOldRunner: reconnected.evidence.some((entry) =>
        entry.kind === "process" &&
        entry.data.action === "transport_closed" &&
        entry.data.reason === "reconnect" &&
        entry.data.runnerExited === true),
      mockStateChanged: comment?.body === "Real Codex changed mock state through ControlPlanePort.",
      typedResultChangedResponse:
        revision !== null && first.assistantText.includes(String(revision)),
      resumedResponseUsesTypedResult:
        revision !== null && second.assistantText.includes(String(revision)),
      noRealPaperclipRequest: beforeShutdown.networkEvidence.realPaperclipRequests === 0,
      noPaperclipAuthorityInChild:
        beforeShutdown.networkEvidence.childPaperclipEnvironmentKeys.length === 0,
      authorityCleared: afterShutdown.authority.active === false,
      runnerExited: afterShutdown.process?.runnerExited === true,
    };
    const output = {
      schema: "paperclip.capability.live-smoke.v1",
      providerThreadId,
      firstTurnId: first.turnId,
      secondTurnId: second.turnId,
      stateRevision: revision,
      firstRunnerPid,
      process: afterShutdown.process,
      networkEvidence: afterShutdown.networkEvidence,
      assertions,
    };
    process.stdout.write(options.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : `${Object.entries(assertions).map(([key, value]) => `${value ? "PASS" : "FAIL"} ${key}`).join("\n")}\n`);
    if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
  } finally {
    if (session !== null && session.snapshot().status !== "closed") {
      await service.shutdown(session.id, "Capability live smoke cleanup");
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
