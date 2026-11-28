import { createServer as createNetServer } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { bindAcpxCandidateAdmission } from "../drivers/acpx/candidate-admission.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "../drivers/acpx/generated-profiles.js";
import {
  acpxRecoveryIdentity,
  acpxRecoveryProfiles,
  createAcpxRecoveryFixture,
  ensureAcpxRecoveryRunnerBuilt,
} from "./acpx-controller-recovery.harness.js";

const profiles = acpxRecoveryProfiles;
const identity = acpxRecoveryIdentity;
const fixture = createAcpxRecoveryFixture;

beforeAll(() => {
  ensureAcpxRecoveryRunnerBuilt();
}, 150_000);

it("preserves a startup provider failure through the real sidecar transport and restored controller journal", async () => {
  const run = await fixture();
  const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
    category: "rate_limit", message: "This request would exceed your account's rate limit.", httpStatus: 429, retryability: "unknown" };
  try {
    writeFileSync(resolve(run.root, "startup-failure.json"), JSON.stringify(providerFailure));
    expect(await run.command("run.prepare", { provider: run.descriptor })).toMatchObject({ status: "completed" });
    const failed = await run.command("session.open");
    expect(failed).toMatchObject({ status: "failed", result: { result: { code: "command_execution_failed", providerFailure } } });
    await run.stopController();
    await run.replaceController();
    expect(run.controller().getCommand("command-2")).toMatchObject({ status: "failed",
      result: { result: { providerFailure } } });
    expect(run.launches()).toHaveLength(1);
  } finally { await run.cleanup(); }
}, 60_000);

async function assertActiveExpiry(candidate = false) {
  // One fixed grant covers the six-second cold delay, the native thirty-second
  // startup bound, and active-turn headroom. The fixture must not time out
  // session.open before the provider admission deadline it exercises.
  // Never renew this authority after setup or the active-turn witness.
  const lifetimeMs = 45_000;
  const candidateAdmission = candidate ? bindAcpxCandidateAdmission({ schema: "paperclip.acpx-candidate-admission.v1", companyId: "company-expiry",
    agent: "antigravity", model: "gemini-3.8-flash-low", profileDigest: profiles.profiles.antigravity.commandDigest,
    nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`,
    platform: "darwin", architecture: "arm64", expiresAt: Date.now() + lifetimeMs }, identity) : undefined;
  // A controlled cold start outlasts the default five-second bootstrap ticket.
  // It must still activate inside the original fixed absolute grant.
  const run = await fixture(candidate ? undefined : lifetimeMs, candidateAdmission, candidate ? 0 : 6_000);
  const deadlineAt = run.deadlineAt!;
  try {
    await run.ready();
    expect(await run.command("turn.start", { turnId: "provider-expiring-turn", text: "Keep this hermetic turn active" })).toMatchObject({ status: "completed" });
    const launch = run.launches()[0];
    expect(launch.pid).toBeGreaterThan(1);
    expect(() => process.kill(launch.pid, 0)).not.toThrow();
    expect(await run.command("session.snapshot")).toMatchObject({ result: { result: { activeProviderTurnId: "provider-expiring-turn" } } });
    expect(Date.now()).toBeLessThan(deadlineAt);
    // No stop/cancel request is sent. The real daemon must enforce the launch
    // deadline while the provider is active, then finish physical cleanup.
    await vi.waitFor(() => expect(run.child.exitCode ?? run.child.signalCode).not.toBeNull(), { timeout: Math.max(1, deadlineAt - Date.now()) + 4_000 });
    expect(run.child.exitCode).not.toBe(0);
    expect(() => process.kill(launch.pid, 0)).toThrow();
    expect(run.processGroupId).toBeGreaterThan(1);
    expect(() => process.kill(-run.processGroupId!, 0)).toThrow();
    const fences = await Promise.all((launch.ports as number[]).map(port => new Promise<ReturnType<typeof createNetServer>>((resolveFree, reject) => {
      const probe = createNetServer(); probe.once("error", reject); probe.listen(port, "127.0.0.1", () => resolveFree(probe));
    })));
    await Promise.all(fences.map(server => new Promise<void>((resolveFree, reject) => server.close(error => error ? reject(error) : resolveFree()))));
    const state = JSON.parse(readFileSync(resolve(run.root, "runner/runner-state.json"), "utf8"));
    expect(state.recoverableFailure).toBe("transport_reconnect_deadline_exceeded");
  } finally { await run.cleanup(); }
}

it("expires an active provider turn after a cold bootstrap delay and physically retires its owned processes", () => assertActiveExpiry(), 60_000);
it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "retires an active exact Antigravity candidate at absolute operator expiry with no caller runtime limit",
  () => assertActiveExpiry(true), 60_000);
