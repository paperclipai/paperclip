import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { runnerSuites } from "../catalog.js";
import { productJourneys, parseTargetConfig, preparationPreview, isAgentJourney, agentJourneyRuns } from "./catalog.js";
import { journeyFixtures } from "./fixtures.js";
import { taskProperties } from "./task-properties.js";
import { askQuestion, taskCreate } from "./basic-flows.js";
import { runAgentJourney } from "./agent-flows.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type JourneyOutcome, type TargetLifecycleInput, type TargetProvider, type TargetSession } from "./types.js";
import type { RunnerE2EResult } from "../types.js";
import { regenerateRunnerDashboard } from "../dashboard-regenerate.js";
import { resolveRunnerE2ESource } from "../source.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import { validateJourneyCollection } from "./collection.js";
import { captureProductScreenshot } from "./product-screenshot.js";
import { validateOnboardingArtifact } from "./artifact-evidence.js";

const cleanupGraceMs = 600_000;
const stopReserveMs = 20_000;
const browserCloseReserveMs = 10_000;

/** Providers must fence late mutations when this signal is aborted. */
async function withinLifecycleDeadline<T>(deadlineAt: number, code: string, operation: (input: TargetLifecycleInput) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const expiration = new Promise<never>((_resolve, reject) => {
    cancel = () => { controller.abort(); reject(new JourneyError("failed", code)); };
    if (deadlineAt <= Date.now() || parentSignal?.aborted) cancel();
    else {
      timer = setTimeout(cancel, deadlineAt - Date.now());
      parentSignal?.addEventListener("abort", cancel, { once: true });
    }
  });
  try {
    const value = await Promise.race([expiration, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new JourneyError("failed", code);
      return operation({ signal: controller.signal, deadlineAt });
    })]);
    if (controller.signal.aborted || parentSignal?.aborted || Date.now() >= deadlineAt) {
      controller.abort();
      throw new JourneyError("failed", code);
    }
    return value;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", cancel);
  }
}

export function journeyFailure(error: unknown): { outcome: Exclude<JourneyOutcome, "passed">; code: string } {
  if (error instanceof JourneyError) return error;
  const candidate = error as { outcome?: string; code?: string } | null;
  if (candidate && ["failed", "blocked", "unsupported"].includes(candidate.outcome ?? "") && /^[a-z][a-z0-9_-]{0,100}$/.test(candidate.code ?? "")) {
    return { outcome: candidate.outcome as Exclude<JourneyOutcome, "passed">, code: candidate.code! };
  }
  // Browser errors may contain keys, codes, URLs and form values. Never retain them.
  return { outcome: "failed", code: "journey_operation_failed" };
}

export async function launchProductJourneys(args: string[], repositoryRoot: string) {
  args = args.filter(arg => arg !== "--");
  if (args.includes("--list") && !args.includes("--target-config")) { console.log(JSON.stringify(productJourneys, null, 2)); return; }
  const allowed = new Set(["--target-config", "--output", "--preview", "--list", "--suite"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!allowed.has(flag)) throw new Error("unknown_product_journey_option");
    if (!["--preview", "--list"].includes(flag)) {
      const value = args[++i]; if (!value || value.startsWith("--") || values.has(flag)) throw new Error("invalid_product_journey_option");
      values.set(flag, value);
    }
  }
  const file = values.get("--target-config");
  if (!file) throw new Error("target_config_required");
  const config = parseTargetConfig(JSON.parse(await readFile(file, "utf8")));
  if (args.includes("--preview") || args.includes("--list")) { console.log(JSON.stringify(preparationPreview(config), null, 2)); return; }
  const campaignId = `journey-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.resolve(values.get("--output") ?? path.join(repositoryRoot, "tests/runner-e2e/results", campaignId));
  // A campaign directory is exclusive; attempts are never overwritten.
  await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const deadlineAt = Date.now() + config.limits.durationMs;
  const controller = new AbortController();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const abort = () => { controller.abort(); for (const page of context?.pages() ?? []) void page.close().catch(() => {}); };
  let session: TargetSession | undefined;
  let ready: JourneyContext | undefined;
  let fixtures: ReturnType<typeof journeyFixtures> | undefined;
  let prerequisiteFailure: ReturnType<typeof journeyFailure> | undefined;
  let releaseSettled = false;
  let cleanupDeadlineAt = 0;
  let cleanupWorkDeadlineAt = 0;
  const results: RunnerE2EResult[] = [];
  let sha: string | null = null;
  try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Packaged harnesses may not include Git metadata. */ }
  const source = resolveRunnerE2ESource({ sha, ref: null, workflowRunUrl: null });
  const definitionHash = createHash("sha256").update(JSON.stringify(productJourneys));
  for (const name of ["catalog.ts", "task-properties.ts", "basic-flows.ts", "basic-evidence.ts", "agent-flows.ts", "success-contract.ts", "product-screenshot.ts", "cloud-onboarding.ts", "onboarding-connect.ts", "onboarding-first-task.ts", "workspace-deferral.ts", "onboarding-pre-acceptance.ts", "artifact-evidence.ts", "fixtures.ts", "launch.ts", "types.ts", "collection.ts", "local-target.ts"]) definitionHash.update(await readFile(path.join(import.meta.dirname, name)));
  for (const file of ["catalog.ts", "api.ts", "run-observations.ts", "native-task-reply.ts", "native-event-envelope.ts", "user-actions.ts", "plan-revision-flow.ts", "skill-studio-flow.ts", "protected-action-flow.ts", "story-artifact.ts", "stop-redirect-flow.ts", "everyday-cases.ts", "everyday-delivery.ts", "everyday-decisions.ts", "connection-guidance-evidence.ts", "everyday-artifact.py"]) definitionHash.update(await readFile(path.join(import.meta.dirname, "..", file)));
  definitionHash.update(runnerSuites.flatMap(suite => suite.tasks).find(task => task.id === "ask-question")!.buildPrompt("definition"));
  const suiteDefinitionHash = definitionHash.digest("hex");
  const expected = config.journeys.map(id => `product-journeys.${config.id}.${id === "cloud-onboarding" ? config.modelProfileId : isAgentJourney(id) ? "configured-agent" : "browser"}.${config.executionEnvironment}.${id}`);
  let reportPersisted = false;
  const failFinalization = (code: string) => {
    for (const result of results) {
      result.status = "failed"; result.cleanup = "failed"; result.failureClass = "cleanup_failure";
      result.error ??= code;
      if (result.productJourney!.outcome === "passed") result.productJourney!.outcome = "failed";
      result.productJourney!.resourceDisposition = "cleanup-failed";
      if (!result.productJourney!.phases.some(phase => phase.phase === "cleanup" && phase.code === code)) {
        result.productJourney!.phases.push({ phase: "cleanup", outcome: "failed", code });
      }
    }
  };
  const persist = async () => {
    try {
      await writeFile(path.join(outputDir, "normalized-results.tmp"), JSON.stringify({ schema: "paperclip.runner-e2e.campaign/v2", campaignId, generatedAt: new Date().toISOString(), expected, source, results }, null, 2), { mode: 0o600 });
      await rename(path.join(outputDir, "normalized-results.tmp"), path.join(outputDir, "normalized-results.json"));
      reportPersisted = true;
    } catch {
      reportPersisted = false;
      failFinalization("evidence_persistence_failed");
      throw new JourneyError("failed", "evidence_persistence_failed");
    }
  };
  const persistSafely = async () => { try { await persist(); return true; } catch { return false; } };
  const renderDashboard = async () => {
    // An uncooperative late renderer can only write its own private staging area.
    // The launcher's normalized results remain authoritative, including failures.
    const staging = path.join(outputDir, `.dashboard-${randomUUID()}`);
    await withinLifecycleDeadline(cleanupWorkDeadlineAt, "report_generation_timeout", async () => {
      await mkdir(staging, { mode: 0o700 });
      await regenerateRunnerDashboard({ bundle: outputDir, historyFile: null, outputDirectory: staging });
    });
    // Publication has no async gap in which a timeout can persist a newer failure.
    if (Date.now() >= cleanupWorkDeadlineAt) throw new JourneyError("failed", "report_generation_timeout");
    renameSync(path.join(staging, "index.html"), path.join(outputDir, "index.html"));
    renameSync(path.join(staging, "dashboard.html"), path.join(outputDir, "dashboard.html"));
  };
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const timer = setTimeout(abort, config.limits.durationMs);
  try {
    try {
      browser = await chromium.launch({ headless: !config.headed, ...(process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {}) });
      context = await browser.newContext();
      context.setDefaultTimeout(30_000);
      if (controller.signal.aborted) throw new JourneyError("blocked", "campaign_deadline_or_interruption");
      const loaded = config.mode === "managed-self-hosted" ? await import("./local-target.js") : await import(pathToFileURL(path.resolve(config.adapterModule!)).href);
      const provider = loaded.provider as TargetProvider;
      if (provider?.version !== 1 || typeof provider.acquire !== "function") throw new JourneyError("blocked", "unsupported_target_provider_contract");
      session = await provider.acquire({ config, campaignId, deadlineAt, browser: context, signal: controller.signal, repositoryRoot, outputDir, harness: { revision: source.sha, definitionHash: suiteDefinitionHash } });
      await session.authenticate();
      fixtures = journeyFixtures(session, campaignId);
    } catch (error) { prerequisiteFailure = journeyFailure(error); }
    for (const [index, id] of config.journeys.entries()) {
      const startedAt = new Date().toISOString();
      const evidence: JourneyEvidence = { targetId: config.id, outcome: "blocked", startingState: ready?.startingState ?? "recipe", phases: [], checks: [], resourceDisposition: "cleanup-failed", privacy: "private", campaignId, attemptId: `${campaignId}:${id}:1` };
      const profile = id === "cloud-onboarding" ? runnerSuites.flatMap(suite => suite.profiles).find(p => p.id === config.modelProfileId) : undefined;
      const result: RunnerE2EResult = {
        schema: "paperclip.runner-e2e.result/v2", executionId: expected[index]!, suiteId: "product-journeys", suiteDefinitionHash,
        source, attempt: 1, status: "failed", profileId: isAgentJourney(id) ? "configured-agent" : profile?.id ?? "browser", environmentId: config.executionEnvironment, caseId: id,
        provider: profile?.provider ?? null, model: profile?.model ?? null, runtimeMode: profile?.generation ?? "none", startedAt, finishedAt: startedAt, durationMs: 0, cleanup: "not_started", productJourney: evidence,
      };
      results.push(result);
      let phase: JourneyEvidence["phases"][number]["phase"] = "authentication";
      try {
        if (prerequisiteFailure) {
          if (index === 0) throw new JourneyError(prerequisiteFailure.outcome, prerequisiteFailure.code);
          throw new JourneyError("blocked", "prerequisite_journey_failed");
        }
        if (controller.signal.aborted) throw new JourneyError("blocked", "campaign_deadline_or_interruption");
        evidence.phases.push({ phase: "authentication", outcome: "passed" });
        await persist();
        phase = id === "cloud-onboarding" ? "journey" : "setup";
        if (id === "cloud-onboarding") {
          if (!session!.onboard) throw new JourneyError("unsupported", "target_has_no_onboarding");
          ready = await session!.onboard(evidence);
          if (!evidence.artifact) throw new JourneyError("failed", "onboarding_artifact_evidence_missing");
          validateOnboardingArtifact(evidence.artifact);
          fixtures!.provide(ready);
        } else {
          ready = await fixtures!.resolve(productJourneys.find(j => j.id === id)!.requires);
          evidence.phases.push({ phase: "setup", outcome: "passed" });
          evidence.deployment = ready.identity;
          evidence.startingState = ready.startingState;
          await persist();
          phase = "journey";
          if (isAgentJourney(id)) {
            if (!ready.agent) throw new JourneyError("blocked", "configured_agent_required");
            result.profileId = "configured-agent";
            result.provider = ready.agent.provider;
            result.model = ready.agent.model;
            result.runtimeMode = ready.agent.runtimeMode;
            if (id === "ask-question") await askQuestion(ready, session!, campaignId, evidence);
            else await runAgentJourney(id, ready, session!, campaignId, evidence, { deadlineAt,
              directory: path.join(outputDir, "private-stories", id),
              capture: async (_id, _label, file) => {
                const directory = path.join(outputDir, "private-stories", id);
                await mkdir(directory, { recursive: true, mode: 0o700 });
                await captureProductScreenshot(ready!.page, ready!.api.origin, path.join(directory, file));
              } });
          } else if (id === "task-create") await taskCreate(ready, session!, campaignId, evidence);
          else await taskProperties(ready, session!, campaignId, evidence);
        }
        evidence.deployment = ready.identity;
        evidence.startingState = ready.startingState;
        if (JSON.stringify(await session!.identity()) !== JSON.stringify(ready.identity)) throw new JourneyError("failed", "deployment_changed_during_journey");
        evidence.outcome = "passed";
        evidence.phases.push({ phase: "journey", outcome: "passed" });
        result.status = "passed";
        const evidenceDir = path.join(outputDir, "evidence", result.executionId, "attempt-1");
        await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
        await captureProductScreenshot(ready.page, ready.api.origin, path.join(evidenceDir, `${id}.png`));
        result.screenshots = [{ id, label: productJourneys.find(j => j.id === id)!.label, file: `${id}.png` }];
      } catch (error) {
        const failure = journeyFailure(error);
        evidence.outcome = failure.outcome;
        evidence.phases.push({ phase, ...failure });
        result.status = "failed";
        result.error = failure.code;
        result.failureClass = failure.outcome === "failed" ? "candidate_failure" : "permanent_infrastructure";
        // Retain failed product screens only after tenant setup, never login screens.
        if (ready && phase === "journey") {
          try {
            const url = new URL(ready.page.url());
            if (url.origin === ready.api.origin && /^\/[^/]+\/(issues|search)(\/|$)/.test(url.pathname)) {
              const evidenceDir = path.join(outputDir, "evidence", result.executionId, "attempt-1");
              await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
              await captureProductScreenshot(ready.page, ready.api.origin, path.join(evidenceDir, `${id}-failed.png`));
              result.screenshots = [{ id: `${id}-failed`, label: "Failed journey screen", file: `${id}-failed.png` }];
            }
          } catch { /* Preserve the original failure when its page is unavailable. */ }
        }
        if (id === "cloud-onboarding" || !ready) prerequisiteFailure = failure;
      }
      result.finishedAt = new Date().toISOString(); result.durationMs = Date.parse(result.finishedAt) - Date.parse(startedAt);
      if (!await persistSafely()) prerequisiteFailure ??= { outcome: "failed", code: "evidence_persistence_failed" };
    }
  } finally {
    try {
      const collected = await withinLifecycleDeadline(deadlineAt, "evidence_collection_timeout", input => session?.collect(input) ?? Promise.resolve([]), controller.signal) ?? [];
      const seen = new Set<string>();
      for (const receipt of collected) {
        validateJourneyCollection(receipt);
        const result = results.find(r => r.caseId === receipt.journeyId);
        if (!result || seen.has(receipt.journeyId) || receipt.operations && (receipt.operations.campaignId !== campaignId || receipt.operations.attemptId !== result.productJourney!.attemptId)) throw new JourneyError("failed", "foreign_or_duplicate_operations_receipt");
        seen.add(receipt.journeyId);
        // Validate the normalized boundary before retaining any adapter output.
        const candidate = { ...result, status: "failed", runIds: receipt.runIds, usage: receipt.usage, productJourney: { ...result.productJourney!, operations: receipt.operations } };
        validateRetainedRunnerResult(candidate);
        result.runIds = receipt.runIds;
        result.usage = receipt.usage;
        if (receipt.operations) result.productJourney!.operations = receipt.operations;
      }
      for (const result of results) {
        if (isAgentJourney(result.caseId as import("./types.js").JourneyId) && result.status === "passed"
          && (!seen.has(result.caseId) || result.runIds?.length !== agentJourneyRuns[result.caseId as keyof typeof agentJourneyRuns])) throw new JourneyError("failed", "paid_journey_receipt_missing");
        if (result.caseId === "cloud-onboarding" && result.status === "passed" && (!seen.has(result.caseId) || !result.runIds?.length || !result.productJourney?.operations || !result.productJourney.operations.traceIds.length)) throw new JourneyError("failed", "paid_journey_receipt_missing");
        // Success-only checks must run before a disposable target can be deleted.
        // Cleanup is provisional here; the observed cleanup result is retained below.
        if (result.status === "passed") validateRetainedRunnerResult({ ...result, cleanup: "passed" });
      }
      for (const result of results) result.productJourney!.phases.push({ phase: "collection", outcome: "passed" });
    } catch (error) {
      const failure = journeyFailure(error);
      for (const result of results) { result.status = "failed"; if (result.productJourney!.outcome === "passed") { result.productJourney!.outcome = "failed"; result.error = failure.code; } result.productJourney!.phases.push({ phase: "collection", outcome: "failed", code: ["paid_journey_receipt_missing", "evidence_collection_timeout"].includes(failure.code) ? failure.code : "evidence_collection_failed" }); }
    }
    clearTimeout(timer);
    cleanupDeadlineAt = Date.now() + cleanupGraceMs;
    cleanupWorkDeadlineAt = cleanupDeadlineAt - stopReserveMs - browserCloseReserveMs;
    // A private provider checkpoints the measured evidence before deleting resources.
    await persistSafely();
    try {
      const disposition = await withinLifecycleDeadline(cleanupWorkDeadlineAt, "target_cleanup_timeout", input => session?.release(results.every(r => r.status === "passed") ? "passed" : "failed", input) ?? Promise.resolve("released" as const));
      releaseSettled = true;
      for (const result of results) { if (result.cleanup !== "failed") result.cleanup = "passed"; result.productJourney!.resourceDisposition = disposition; result.productJourney!.phases.push({ phase: "cleanup", outcome: "passed" }); }
    } catch (error) {
      failFinalization(error instanceof JourneyError && error.code === "target_cleanup_timeout" ? error.code : "target_cleanup_failed");
      // A timed-out release may still have an in-flight request. Stop-only recovery
      // gets its own bounded signal and cannot delete resources or free the lease.
      try { await withinLifecycleDeadline(Math.min(cleanupDeadlineAt - browserCloseReserveMs, Date.now() + stopReserveMs), "target_stop_timeout", input => session?.stop?.(input) ?? Promise.resolve()); }
      catch { failFinalization("target_stop_failed"); }
    }
    try { await withinLifecycleDeadline(Math.min(cleanupDeadlineAt, Date.now() + browserCloseReserveMs), "browser_cleanup_timeout", () => browser?.close() ?? Promise.resolve()); }
    catch (error) { failFinalization(error instanceof JourneyError && error.code === "browser_cleanup_timeout" ? error.code : "browser_cleanup_failed"); }
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    await persistSafely();
  }
  // If the final write failed, make one bounded attempt to retain that failure itself.
  if (!reportPersisted) await persistSafely();
  if (reportPersisted) {
    try { await renderDashboard(); }
    catch { failFinalization("report_generation_failed"); await persistSafely(); }
  }
  try {
    if (reportPersisted) await withinLifecycleDeadline(cleanupWorkDeadlineAt, "evidence_finalization_timeout", input => {
      // Only a settled release can authorize lease-releasing finalization.
      return (releaseSettled ? session?.finalizeEvidence?.(input) : session?.checkpointEvidence?.(input)) ?? Promise.resolve();
    });
  }
  catch {
    failFinalization("evidence_finalization_failed");
    await persistSafely();
    if (reportPersisted) {
      try { await renderDashboard(); } catch { /* Durable provider checkpoint and cleanup failure remain recoverable. */ }
      try { await withinLifecycleDeadline(cleanupWorkDeadlineAt, "evidence_checkpoint_timeout", input => session?.checkpointEvidence?.(input) ?? Promise.resolve()); } catch { /* Keep the provider's pending manifest and exclusive leases for recovery. */ }
    }
  }
  if (!reportPersisted) console.error("evidence_persistence_failed");
  console.log(`Product journeys: ${results.filter(r => r.status === "passed").length}/${results.length} passed; ${reportPersisted ? `private report ${outputDir}/dashboard.html` : "evidence pending recovery"}`);
  if (!reportPersisted || results.some(r => r.status !== "passed")) process.exitCode = 1;
}
