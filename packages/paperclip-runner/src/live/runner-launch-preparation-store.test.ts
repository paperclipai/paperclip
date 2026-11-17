import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RunnerLaunchPreparationStore } from "./runner-launch-preparation-store.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, runnerProviderLaunchRequirements } from "./runner-provider-launch.js";

function preparation(runId: string) {
  const requirements = runnerProviderLaunchRequirements({ provider: "codex" },
    { runnerInstanceId: "runner", environmentLeaseId: "lease", normalizedSessionId: "session", runId,
      turnId: `turn-${runId}`, itemId: `item-${runId}` }, { model: "selected" }, null, "Core instructions");
  return { requirements, prepared: { configurationId: runId, requirementsDigest: runnerLaunchRequirementsDigest(requirements),
    provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: [] }, root: "/guest/state", cwd: "/guest/work",
      codexHome: "/guest/.codex", codexCommand: "/guest/codex", providerNodeCommand: "", opencodeProxyPath: "", acpxSidecarPath: "" }) } };
}

it("retains only the two latest exact preparation records across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-preparation-store-"));
  try {
    const store = new RunnerLaunchPreparationStore(root);
    const first = preparation("first"), second = preparation("second"), third = preparation("third");
    for (const [entry, active] of [[first, first], [second, first], [third, second]] as const)
      store.save(entry.requirements, entry.prepared, active.requirements.identity);
    const restored = new RunnerLaunchPreparationStore(root);
    expect(restored.load(first.requirements.identity)).toBeUndefined();
    expect(restored.load(second.requirements.identity)).toEqual(second);
    expect(restored.load(third.requirements.identity)).toEqual(third);
    expect(restored.load({ ...third.requirements.identity, environmentLeaseId: "other" })).toBeUndefined();
    if (process.platform !== "win32") expect(statSync(join(root, "launch-preparation.json")).mode & 0o777).toBe(0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("rejects changed requirements or prepared configurations for the same identity", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-preparation-conflict-"));
  try {
    const store = new RunnerLaunchPreparationStore(root);
    const { requirements, prepared } = preparation("run");
    store.save(requirements, prepared, requirements.identity);
    expect(() => store.save(requirements, { ...prepared, configurationId: "changed" }, requirements.identity))
      .toThrow("runner_prepared_launch_recovery_changed");
    const changed = { ...requirements, instructions: "Changed instructions" };
    expect(() => store.save(changed, { ...prepared, requirementsDigest: runnerLaunchRequirementsDigest(changed),
      provider: { ...prepared.provider, instructions: "Changed instructions" } }, requirements.identity))
      .toThrow("runner_prepared_launch_recovery_changed");
    expect(store.load(requirements.identity)).toEqual({ requirements, prepared });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("fails closed on corrupt or unsupported recovery metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-preparation-corrupt-"));
  try {
    const store = new RunnerLaunchPreparationStore(root);
    const { requirements, prepared } = preparation("run");
    store.save(requirements, prepared, requirements.identity);
    const path = join(root, "launch-preparation.json");
    const contents = JSON.parse(readFileSync(path, "utf8"));
    contents.entries[0].prepared.requirementsDigest = `sha256:${"0".repeat(64)}`;
    writeFileSync(path, JSON.stringify(contents));
    expect(() => store.load(requirements.identity)).toThrow();
    writeFileSync(path, JSON.stringify({ ...contents, schema: "unsupported" }));
    expect(() => store.load(requirements.identity)).toThrow("runner_launch_recovery_requirements_unavailable");
    writeFileSync(path, "{");
    expect(() => store.load(requirements.identity)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps the active run when multiple new attachment attempts fail", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-preparation-active-"));
  try {
    const store = new RunnerLaunchPreparationStore(root);
    const active = preparation("active");
    store.save(active.requirements, active.prepared, active.requirements.identity);
    for (const runId of ["failed-first", "failed-second", "failed-third"]) {
      const entry = preparation(runId);
      store.save(entry.requirements, entry.prepared, active.requirements.identity);
    }
    expect(store.load(active.requirements.identity)).toEqual(active);
    expect(JSON.parse(readFileSync(join(root, "launch-preparation.json"), "utf8")).entries).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
