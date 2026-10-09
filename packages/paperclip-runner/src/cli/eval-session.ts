#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  composeNativeSystemInstructions,
  nativeRuntimePromptDigest,
  parseNativeRuntimeContext,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
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
  type EvalCandidateProfile,
  type EvalSessionUsage,
} from "./eval-session-contract.js";
import { evalProviderTransportOptions } from "./eval-provider-runtime.js";

interface EvalSessionCliOptions {
  requestPath: string;
  outputPath: string;
  candidateProfile?: EvalCandidateProfile;
  expectedAcpxProfile?: Record<string, unknown>;
}

function argument(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return resolve(value);
}

export function parseEvalSessionCliArgs(args: string[]): EvalSessionCliOptions {
  const allowed = new Set(["--request", "--output", "--candidate-profile", "--expected-acpx-profile"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index] ?? "")) {
      throw new Error(`unknown argument: ${args[index] ?? ""}`);
    }
    if (seen.has(args[index]!)) throw new Error(`duplicate argument: ${args[index]}`);
    seen.add(args[index]!);
    if (args[index + 1] === undefined || args[index + 1]!.startsWith("--")) throw new Error(`missing ${args[index]}`);
  }
  const candidateIndex = args.indexOf("--candidate-profile");
  const candidateProfile = candidateIndex < 0 ? undefined : args[candidateIndex + 1];
  if (candidateProfile !== undefined && candidateProfile !== "pi" && candidateProfile !== "cursor" && candidateProfile !== "copilot") {
    throw new Error("--candidate-profile must be pi, cursor, or copilot");
  }
  const expectedIndex = args.indexOf("--expected-acpx-profile");
  const expectedText = expectedIndex < 0 ? undefined : args[expectedIndex + 1];
  if (candidateProfile !== undefined && expectedText === undefined) {
    throw new Error("Candidate evals require --expected-acpx-profile before provider execution");
  }
  let expectedAcpxProfile: Record<string, unknown> | undefined;
  if (expectedText !== undefined) {
    if (Buffer.byteLength(expectedText, "utf8") > 4_096) {
      throw new Error("--expected-acpx-profile exceeds its 4096-byte bound");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(expectedText); } catch {
      throw new Error("--expected-acpx-profile must be a JSON object");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--expected-acpx-profile must be a JSON object");
    }
    expectedAcpxProfile = parsed as Record<string, unknown>;
  }
  return {
    ...(candidateProfile === undefined ? {} : { candidateProfile }),
    ...(expectedAcpxProfile === undefined ? {} : { expectedAcpxProfile }),
    requestPath: argument(args, "--request"),
    outputPath: argument(args, "--output"),
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const EVAL_RUNTIME_INSTRUCTIONS = [
  "# Paperclip direct live evaluation",
  "",
  "Use the provided Paperclip semantic tools to inspect and act on the assigned task.",
  "Treat the seeded control-plane state as authoritative and keep every action within the requested scope.",
  "The current user request defines the work for this turn. Seeded task descriptions, notes, and past interaction results are background context; they do not supersede that request or establish that a newly requested action has already been performed.",
  "Task-state changes in this mock control plane use finish_task and block_task. Native paperclip_finish and paperclip_block report the provider run result but do not update the mock task. When asked to finish or block the assigned task, use its task-state semantic operation before reporting the run result.",
  "Do not finish or block the mock task unless the current request asks for that state change. Ending the provider turn after another requested action does not authorize additional task-state changes or completion comments.",
  "",
].join("\n");

/** Materializes the minimal immutable v3 context used by production-native providers. */
export async function prepareEvalRuntimeContext(
  workingDirectory: string,
): Promise<NativeRuntimeContextSnapshot> {
  const contextRoot = await mkdtemp(
    resolve(workingDirectory, ".paperclip-eval-runtime-context-"),
  );
  const instructionRoot = resolve(contextRoot, "instructions");
  const entryPath = "AGENTS.md";
  const entry = Buffer.from(EVAL_RUNTIME_INSTRUCTIONS);
  const entryDigest = createHash("sha256").update(entry).digest("hex");
  const manifestFiles = [{
    path: entryPath,
    sha256: entryDigest,
    mode: 0o444,
    size: entry.byteLength,
  }];
  const assetDigest = createHash("sha256")
    .update(JSON.stringify(manifestFiles))
    .digest("hex");
  const manifestText = `${JSON.stringify({
    schema: "paperclip.runtime-asset-manifest.v1",
    digest: assetDigest,
    fileCount: manifestFiles.length,
    totalBytes: entry.byteLength,
    files: manifestFiles,
  })}\n`;
  const manifestDigest = createHash("sha256")
    .update(manifestText)
    .digest("hex");
  await mkdir(instructionRoot, { recursive: true, mode: 0o700 });
  const entryFile = resolve(instructionRoot, entryPath);
  await writeFile(entryFile, entry, { flag: "wx", mode: 0o444 });
  await chmod(entryFile, 0o444);
  await chmod(instructionRoot, 0o555);

  const semanticCatalogDigest =
    PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog.sha256.replace(
      /^sha256:/,
      "",
    );
  const context = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath,
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest: assetDigest,
        manifestDigest,
        rootPath: instructionRoot,
        fileCount: 1,
        totalBytes: entry.byteLength,
      },
    },
    skills: [],
    mcp: {
      assignmentSetId: "paperclip-runner-direct-eval-v1",
      digest: semanticCatalogDigest,
      bindingId: null,
    },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return parseNativeRuntimeContext({
    ...context,
    aggregateDigest: canonicalNativeRuntimeContextDigest(context),
  });
}

export function evalRuntimeSystemInstructions(
  runtimeContext: NativeRuntimeContextSnapshot,
): string {
  return composeNativeSystemInstructions(
    runtimeContext,
    EVAL_RUNTIME_INSTRUCTIONS,
  );
}

export function evalSessionProviderVersion(
  request: EvalSessionRequest,
): string | null {
  if (request.provider === "opencode") {
    const version = request.opencodeVersion ?? "1.18.34";
    if (version !== "1.18.34") {
      throw new Error(`OpenCode evals require exact version 1.18.34; received ${version}`);
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
    return request.agentCoreProfile!.qualificationRevision;
  }
  return null;
}

class EvalSessionBudgetError extends Error {
  constructor(message: string, readonly coverageUnknown = false) {
    super(message);
    this.name = "EvalSessionBudgetError";
  }
}

function failureClass(error: unknown): {
  class: string;
  category: string;
  retryable: boolean;
  diagnostics: Record<string, never>;
} {
  if (error instanceof EvalSessionBudgetError && error.coverageUnknown) {
    return { class: "provider_budget_coverage_unknown", category: "provider_budget", retryable: false, diagnostics: {} };
  }
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

export function boundedEvalSessionUsage(
  request: EvalSessionRequest,
  turn: CapabilityLiveTurnResult,
): EvalSessionUsage | null {
  if (turn.status !== "completed") {
    return usageIfAvailable(request, turn.snapshot);
  }
  if (request.provider === "acpx" && request.acpxAgent === "grok" && !turn.snapshot.usageLedger?.length) {
    throw new EvalSessionBudgetError("budget cost coverage is unavailable for the completed Grok turn", true);
  }
  const candidate = request.provider === "acpx"
    && request.acpxAgent !== undefined
    && ["pi", "cursor", "copilot"].includes(request.acpxAgent)
    && turn.snapshot.config.provider === "acpx"
    && turn.snapshot.config.acpxAgent === request.acpxAgent;
  const measuredTurns = new Set(turn.snapshot.usageLedger?.map((entry) => entry.turnId));
  const unavailableTurnIds = new Set(candidate
    ? turn.snapshot.usageUnavailable?.filter((entry) => entry.agent === request.acpxAgent
      && entry.reason === "provider_did_not_report_usage"
      && entry.tokenUsage === null && entry.costNanodollars === null
      && !measuredTurns.has(entry.turnId)).map((entry) => entry.turnId)
    : []);
  const unavailable = unavailableTurnIds.size > 0;
  const usage = unavailable && (unavailableTurnIds.has(turn.turnId) || turn.snapshot.usageLedger?.length)
    ? usageIfAvailable(request, turn.snapshot)
    : evalSessionUsage(request.model, turn.snapshot);
  const unavailableTurns = unavailableTurnIds.size;
  if ((usage?.agentTurns ?? 0) + unavailableTurns > request.limits.maxAgentTurns) {
    throw new EvalSessionBudgetError("agent turn limit exceeded");
  }
  if (
    usage !== null && usage.estimatedCostNanodollars !== null &&
    usage.estimatedCostNanodollars >
    request.limits.maxEstimatedCostNanodollars
  ) {
    throw new EvalSessionBudgetError("estimated cost limit exceeded");
  }
  if (
    usage !== null && usage.providerReportedCostNanodollars !== null &&
    usage.providerReportedCostNanodollars >
    request.limits.maxEstimatedCostNanodollars
  ) {
    throw new EvalSessionBudgetError("provider-reported cost limit exceeded");
  }
  if (unavailable || usage === null || (usage.estimatedCostNanodollars === null && usage.providerReportedCostNanodollars === null)) {
    throw new EvalSessionBudgetError("budget cost coverage is unavailable for one or more completed turns", true);
  }
  return usage;
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
    { candidateProfile: cli.candidateProfile },
  );
  // Check the built CLI's profile before constructing any runtime context,
  // transport or service. Scoring after a paid turn is too late for admission.
  if (cli.expectedAcpxProfile !== undefined) {
    if (request.provider !== "acpx") {
      throw new Error("--expected-acpx-profile requires an ACPX request");
    }
    const actualProfile = resolveQualifiedAcpxProfile(request.acpxAgent ?? "codex", request.model);
    const entries = Object.entries(actualProfile);
    if (Object.keys(cli.expectedAcpxProfile).length !== entries.length || entries.some(
      ([key, value]) => !Object.hasOwn(cli.expectedAcpxProfile!, key) || cli.expectedAcpxProfile![key] !== value,
    )) {
      throw new Error("--expected-acpx-profile does not match the built runner profile");
    }
  }
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
  const requestedProviderVersion = evalSessionProviderVersion(request);
  const runtimeContext = await prepareEvalRuntimeContext(
    resolve(request.session.workingDirectory ?? process.cwd()),
  );
  const service = options.serviceFactory?.(runnerdPath) ??
    new CapabilityLiveSessionService({
      transportOptions: {
        ...evalProviderTransportOptions(requestedProvider, request.limits.turnTimeoutMs),
        runnerBinary: runnerdPath,
        ...(cli.candidateProfile === undefined ? {} : { acpxCandidateProfile: cli.candidateProfile }),
        runtimeContext,
        baseInstructions: evalRuntimeSystemInstructions(runtimeContext),
        // The transport performs the provider-specific allowlisting. Supplying
        // the source environment here is still required: without it the
        // isolated Codex home has no credential source and runnerd receives no
        // executable PATH from the Evalbook CLI process.
        environment: process.env,
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
    let usage: EvalSessionUsage | null;
    let accountingError: EvalSessionBudgetError | null = null;
    try {
      usage = boundedEvalSessionUsage(request, turn);
    } catch (error) {
      if (!(error instanceof EvalSessionBudgetError)) throw error;
      // A completed provider outcome remains inspectable even when its budget
      // cannot be verified. Never turn unknown cost into a successful CLI run.
      accountingError = error;
      usage = usageIfAvailable(request, turn.snapshot);
    }
    await session.completeAttempt(
      accountingError === null && turn.status === "completed" ? "succeeded" : "failed",
      accountingError !== null ? failureClass(accountingError).class
        : turn.status === "completed" ? null : `provider_turn_${turn.status}`,
    );
    await closeSession(session, "eval session complete");
    snapshot = session.snapshot();

    await writeFile(cli.outputPath, `${JSON.stringify({
      schema: "paperclip-runner/eval-session-artifact/v1",
      attemptId: request.attemptId,
      build: PAPERCLIP_RUNNER_BUILD_METADATA,
      runnerd: { path: "[withheld]", sha256: `sha256:${actualDigest}` },
      requestedModel: request.model,
      ...(cli.candidateProfile === undefined ? {} : { diagnosticCandidateProfile: cli.candidateProfile }),
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
      ...(accountingError === null ? {} : {
        accountingError: accountingError.message,
        accountingFailure: failureClass(accountingError),
      }),
      devtools: projectCapabilityDevtools(snapshot),
      issueThread: projectCapabilityIssueThread({
        snapshot,
        mode: "live",
        replaySource: "live",
      }),
      ...(usage === null ? {} : { usage }),
      timing: {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      },
    }, null, 2)}\n`);
    return accountingError === null ? 0 : 2;
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
      ...(cli.candidateProfile === undefined ? {} : { diagnosticCandidateProfile: cli.candidateProfile }),
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

function isEvalSessionEntrypoint(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    // Node resolves module URLs through symlinks, including /tmp on macOS and
    // package-manager bin links. Compare the same physical paths on both sides.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEvalSessionEntrypoint()) {
  void runEvalSessionCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
