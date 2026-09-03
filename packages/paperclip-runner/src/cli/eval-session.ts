#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { projectCapabilityDevtools } from "../devtools/index.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { PAPERCLIP_RUNNER_BUILD_METADATA } from "../evals/build-metadata.js";
import { projectCapabilityIssueThread } from "../issue-thread/live-projection.js";
import {
  CapabilityLiveSessionService,
  type CapabilityLiveSession,
  type CapabilityLiveSessionSnapshot,
  type CapabilityLiveTurnResult,
  type CreateCapabilityLiveSessionInput,
} from "../live/live-session.js";
import {
  evalSessionUsage,
  expectedEvalSessionDriver,
  parseEvalSessionRequest,
  type EvalSessionRequest,
  type EvalSessionUsage,
} from "./eval-session-contract.js";

interface EvalSessionCliOptions {
  requestPath: string;
  outputPath: string;
}

function argument(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return resolve(value);
}

export function parseEvalSessionCliArgs(args: string[]): EvalSessionCliOptions {
  const allowed = new Set(["--request", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index] ?? "")) {
      throw new Error(`unknown argument: ${args[index] ?? ""}`);
    }
    if (args[index + 1] === undefined) throw new Error(`missing ${args[index]}`);
  }
  return {
    requestPath: argument(args, "--request"),
    outputPath: argument(args, "--output"),
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function providerVersion(request: EvalSessionRequest): string | null {
  if (request.provider === "opencode") {
    const version = request.opencodeVersion ?? "1.18.17";
    if (version !== "1.18.17") {
      throw new Error(`OpenCode evals require exact version 1.18.17; received ${version}`);
    }
    return version;
  }
  if (request.provider === "acpx") {
    return resolveQualifiedAcpxProfile(
      request.acpxAgent ?? "codex",
      request.model,
    ).acpxVersion;
  }
  if (request.provider === "claude_managed") {
    return request.managedProfile!.agentVersion;
  }
  if (request.provider === "aws_agentcore") {
    return request.agentCoreProfile!.harnessVersion;
  }
  return null;
}

function failureClass(error: unknown): {
  class: string;
  category: string;
  retryable: boolean;
  diagnostics: Record<string, never>;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|timeout/i.test(message)) {
    return {
      class: "provider_turn_timeout",
      category: "provider_lifecycle",
      retryable: true,
      diagnostics: {},
    };
  }
  if (/budget|cost limit|turn limit/i.test(message)) {
    return {
      class: "provider_budget_reached",
      category: "provider_budget",
      retryable: false,
      diagnostics: {},
    };
  }
  if (/runner.*(?:exit|closed|failed)|PRP/i.test(message)) {
    return {
      class: "runner_infrastructure_failure",
      category: "runner_infrastructure",
      retryable: true,
      diagnostics: {},
    };
  }
  return {
    class: "eval_orchestration_failure",
    category: "eval_orchestration",
    retryable: false,
    diagnostics: {},
  };
}

function usageIfAvailable(
  request: EvalSessionRequest,
  snapshot: CapabilityLiveSessionSnapshot | null,
): EvalSessionUsage | null {
  if (!snapshot?.usageLedger?.length) return null;
  try {
    return evalSessionUsage(request.model, snapshot);
  } catch {
    return null;
  }
}

async function closeSession(
  session: CapabilityLiveSession | null,
  reason: string,
): Promise<void> {
  if (session === null || session.snapshot().status === "closed") return;
  await session.shutdown(reason);
}

export async function runEvalSessionCli(
  args: string[],
  options: {
    serviceFactory?: (
      runnerBinary: string,
    ) => CapabilityLiveSessionService;
  } = {},
): Promise<number> {
  const cli = parseEvalSessionCliArgs(args);
  const request = parseEvalSessionRequest(
    JSON.parse(await readFile(cli.requestPath, "utf8")),
  );
  const runnerdPath = resolve(request.runnerd.path);
  const actualDigest = await sha256(runnerdPath);
  if (actualDigest !== request.runnerd.sha256.replace(/^sha256:/, "")) {
    throw new Error(
      `runnerd digest mismatch: expected ${request.runnerd.sha256}, got sha256:${actualDigest}`,
    );
  }

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const requestedProvider = request.provider ?? "codex";
  const requestedDriver = request.driver ??
    expectedEvalSessionDriver(requestedProvider);
  const requestedProviderVersion = providerVersion(request);
  const service = options.serviceFactory?.(runnerdPath) ??
    new CapabilityLiveSessionService({
      transportOptions: {
        runnerBinary: runnerdPath,
        onDiagnostic: (message) => {
          process.stderr.write(`[eval-session runnerd] ${message}\n`);
        },
      },
    });
  let session: CapabilityLiveSession | null = null;
  let turn: CapabilityLiveTurnResult | null = null;
  let snapshot: CapabilityLiveSessionSnapshot | null = null;

  try {
    // PR3 expands this same service input with the two qualified remote
    // profiles. The cast keeps this isolated PR typecheckable before PR3 lands;
    // the runtime fields and their fail-closed validation are already present.
    const createInput = {
      ...request.session,
      provider: requestedProvider,
      requestedModel: request.model,
      ...(requestedProvider === "acpx"
        ? { acpxAgent: request.acpxAgent ?? "codex" }
        : { acpxAgent: undefined }),
      ...(request.managedProfile === undefined
        ? {}
        : { managedProfile: request.managedProfile }),
      ...(request.agentCoreProfile === undefined
        ? {}
        : { agentCoreProfile: request.agentCoreProfile }),
      attemptId: request.attemptId,
      turnTimeoutMs: request.limits.turnTimeoutMs,
    } as unknown as CreateCapabilityLiveSessionInput;
    session = await service.create(createInput);
    turn = await session.sendMessage(request.prompt);
    if (turn.status !== "completed") {
      await session.completeAttempt("failed", `provider_turn_${turn.status}`);
      throw new Error(`provider turn ended with status ${turn.status}`);
    }
    const usage = evalSessionUsage(request.model, turn.snapshot);
    if (usage.agentTurns > request.limits.maxAgentTurns) {
      throw new Error("agent turn limit exceeded");
    }
    if (
      usage.estimatedCostNanodollars >
      request.limits.maxEstimatedCostNanodollars
    ) {
      throw new Error("estimated cost limit exceeded");
    }
    if (
      usage.providerReportedCostNanodollars >
      request.limits.maxEstimatedCostNanodollars
    ) {
      throw new Error("provider-reported cost limit exceeded");
    }
    await session.completeAttempt("succeeded");
    await closeSession(session, "eval session complete");
    snapshot = session.snapshot();

    await writeFile(cli.outputPath, `${JSON.stringify({
      schema: "paperclip-runner/eval-session-artifact/v1",
      attemptId: request.attemptId,
      build: PAPERCLIP_RUNNER_BUILD_METADATA,
      runnerd: { path: "[withheld]", sha256: `sha256:${actualDigest}` },
      requestedModel: request.model,
      provider: requestedProvider,
      driver: requestedDriver,
      providerVersion: requestedProviderVersion,
      providerSessionId: snapshot.providerSessionId,
      ...(requestedProvider === "claude_managed"
        ? {
            managedProfile: request.managedProfile,
            retainedSession: snapshot.providerSessionId !== null,
            retainedSessionStatus: snapshot.providerSessionId === null
              ? "unknown"
              : "retained",
          }
        : {}),
      ...(requestedProvider === "aws_agentcore"
        ? { agentCoreProfile: request.agentCoreProfile }
        : {}),
      ...(requestedProvider === "acpx"
        ? {
            acpxAgent: request.acpxAgent ?? "codex",
            acpxProfile: resolveQualifiedAcpxProfile(
              request.acpxAgent ?? "codex",
              request.model,
            ),
          }
        : {}),
      turn,
      snapshot,
      devtools: projectCapabilityDevtools(snapshot),
      issueThread: projectCapabilityIssueThread({
        snapshot,
        mode: "live",
        replaySource: "live",
      }),
      usage,
      timing: {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      },
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (session !== null) {
      snapshot = session.snapshot();
      const attempt = snapshot.attempts?.find(
        (candidate) => candidate.attemptId === snapshot?.currentAttemptId,
      );
      if (attempt?.status === "running" && snapshot.activeTurnId === null) {
        try {
          await session.completeAttempt(
            "failed",
            failureClass(error).class,
          );
        } catch {
          // The original infrastructure failure remains authoritative.
        }
      }
      try {
        await closeSession(session, "eval session failed");
      } catch {
        // The original infrastructure failure remains authoritative.
      }
      snapshot = session.snapshot();
    }
    const usage = usageIfAvailable(request, snapshot);
    await writeFile(cli.outputPath, `${JSON.stringify({
      schema: "paperclip-runner/eval-session-artifact/v1",
      attemptId: request.attemptId,
      infrastructureError: error instanceof Error ? error.message : String(error),
      infrastructureFailure: failureClass(error),
      build: PAPERCLIP_RUNNER_BUILD_METADATA,
      runnerd: { path: "[withheld]", sha256: `sha256:${actualDigest}` },
      requestedModel: request.model,
      provider: requestedProvider,
      driver: requestedDriver,
      providerVersion: requestedProviderVersion,
      providerSessionId: snapshot?.providerSessionId ?? null,
      ...(requestedProvider === "claude_managed"
        ? {
            managedProfile: request.managedProfile,
            retainedSession: snapshot?.providerSessionId != null,
            retainedSessionStatus: snapshot?.providerSessionId == null
              ? "unknown"
              : "retained",
          }
        : {}),
      ...(requestedProvider === "aws_agentcore"
        ? { agentCoreProfile: request.agentCoreProfile }
        : {}),
      ...(snapshot === null ? {} : { snapshot }),
      ...(usage === null ? {} : { usage }),
      timing: {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      },
    }, null, 2)}\n`);
    return 2;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void runEvalSessionCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
