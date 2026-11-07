import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCapabilityRunnerdCodexTransport, type RunnerdStartupStep } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

const STEP_ORDER = ["runner.runtime.stage", "runner.process.launch", "provider.session.load"];
const PROVIDER_DELAY_MS = 1_500;

/** A slow provider must show up as session load, never as runner process launch. */
function expectProviderTimeInSessionLoad(steps: RunnerdStartupStep[]): void {
  const duration = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name)!;
    return step.endedAtMs - step.startedAtMs;
  };
  expect(duration("provider.session.load")).toBeGreaterThanOrEqual(PROVIDER_DELAY_MS);
  expect(duration("runner.process.launch")).toBeLessThan(PROVIDER_DELAY_MS);
}

function expectOrderedSteps(steps: RunnerdStartupStep[], mode: RunnerdStartupStep["mode"]): void {
  expect(steps.map((step) => step.name)).toEqual(STEP_ORDER);
  for (const [index, step] of steps.entries()) {
    expect(step).toMatchObject({ mode, outcome: "ok" });
    expect(step.endedAtMs).toBeGreaterThanOrEqual(step.startedAtMs);
    // Sub-steps are sequential: each starts at or after the previous one ended.
    if (index > 0) expect(step.startedAtMs).toBeGreaterThanOrEqual(steps[index - 1]!.endedAtMs);
  }
}

it("reports local stage, launch and provider session load for bootstrap and cold resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-startup-steps-"));
  const identity = {
    runnerInstanceId: "startup-steps-runner",
    environmentLeaseId: "startup-steps-lease",
    runId: "first-run",
    normalizedSessionId: "startup-steps-session",
    turnId: "first-turn",
    itemId: "first-item",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    // Delay the provider's own session start and resume. The runner process
    // authenticates first, so the delay belongs to provider.session.load.
    codexArgs: fakeCodexArgs(root, "--thread-start-delay-ms", String(PROVIDER_DELAY_MS),
      "--thread-resume-delay-ms", String(PROVIDER_DELAY_MS)),
    stateDirectory: root,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    runnerReconnectGraceMs: 2_000,
  };
  const bootstrapSteps: RunnerdStartupStep[] = [];
  const first = createCapabilityRunnerdCodexTransport({
    ...options, prpIdentity: identity, onStartupStep: (step) => { bootstrapSteps.push(step); },
  });
  let resumed: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  try {
    const opened = await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    expectOrderedSteps(bootstrapSteps, "bootstrap");
    expectProviderTimeInSessionLoad(bootstrapSteps);
    const thread = opened.thread as { id: string; sessionId: string };
    await first.transport.close();
    // Closing a live transport is not a startup: no further steps.
    expect(bootstrapSteps).toHaveLength(3);

    const resumeSteps: RunnerdStartupStep[] = [];
    // A new run on the saved session rotates authority through run.attach,
    // which restores the provider before the command completes.
    resumed = createCapabilityRunnerdCodexTransport({
      ...options,
      prpIdentity: { ...identity, runId: "second-run", turnId: "second-turn", itemId: "second-item" },
      resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId },
      onStartupStep: (step) => { resumeSteps.push(step); },
    });
    await resumed.transport.request("thread/read", {});
    expectOrderedSteps(resumeSteps, "resume");
    expectProviderTimeInSessionLoad(resumeSteps);
  } finally {
    await resumed?.transport.close().catch(() => undefined);
    await first.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("never lets a failing startup-step sink change startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-startup-steps-sink-"));
  const names: string[] = [];
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root),
    stateDirectory: root,
    onStartupStep: (step) => {
      names.push(step.name);
      throw new Error("diagnostic sink unavailable");
    },
  });
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    expect((opened.thread as { id?: string }).id).toEqual(expect.any(String));
    expect(names).toEqual(STEP_ORDER);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
