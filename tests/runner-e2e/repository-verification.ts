import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerProfileFixture, RunnerTaskFixture } from "./types.js";

export function repositoryProofFiles(nonce: string) {
  return { source: `source-reference-${nonce}.txt`, result: `repository-proof-${nonce}.json` };
}

export function repositoryProofProfile(native: RunnerProfileFixture, legacy?: RunnerProfileFixture): RunnerProfileFixture {
  return { ...native, buildAgent(input) {
    const { instructionsBundle: _manual, ...agent } = (legacy ?? native).buildAgent(input);
    const config = { ...(agent.adapterConfig as Record<string, unknown>), model: native.model };
    if (legacy) {
      delete (config as Record<string, unknown>).extraArgs;
      delete (config as Record<string, unknown>).maxTurnsPerRun;
    }
    return { ...agent, ...(legacy ? { runner: "legacy" } : {}), budgetMonthlyCents: 1000, adapterConfig: config };
  } };
}

export const repositoryProofTasks: readonly RunnerTaskFixture[] = ["repository-output", "convert-and-deliver"].map(id => ({
  id, label: id === "repository-output" ? "Configured repository and accessible output" : "Legacy conversion retains configuration and delivers useful work",
  groups: [], flow: "repository_verification", workMode: "standard", expectedRunCount: 1,
  automaticRetryPolicy: "single_attempt", attemptTimeoutMs: { local: 10 * 60_000, daytona: 15 * 60_000 },
  turnTimeoutMs: 4 * 60_000, expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Verify repository context ${nonce}`,
  buildVisibleMarker: nonce => repositoryProofFiles(nonce).result,
  buildPrompt(nonce) {
    const files = repositoryProofFiles(nonce);
    return [
      "Verify the configured repository and deliver a small proof file. Read the existing checkout; do not replace, clone, or recreate it.",
      `Read ${files.source}. It contains a reference followed by one LF. Preserve the source file unchanged. If it is missing, report the failure instead of creating a replacement.`,
      "Read the current full Git HEAD SHA and compute the SHA-256 of the exact source file bytes, including its final newline.",
      `Write ${files.result} as JSON with exactly these fields: reference (the existing reference without its trailing LF), sourceSha256 (the exact source file hash), and commit (the full Git HEAD SHA).`,
      `Verify the result, register ${files.result} as a downloadable artifact work product with that exact title, and deliver its accessible link in this task. Finish after delivery. Do not create other tasks or agents.`,
    ].join("\n");
  }, buildMatchers: () => [],
}));

export interface RepositoryProofObservation {
  conversion: boolean;
  originalAdapter: string;
  expectedLegacyAdapter: string;
  finalAdapter: string;
  configurationBefore: string;
  configurationAfter: string;
  instructionsBefore: string;
  instructionsAfter: string;
  permissionsPreserved: boolean;
  expectedModel: string;
  actualModel: string | null;
  actualProvider: string | null;
  expectedProvider: string;
  environmentRetained: boolean;
  issueDone: boolean;
  runCount: number;
  committedRuns: number;
  sourceBytes: string;
  currentSourceBytes: string | null;
  expectedCommit: string;
  downloaded: unknown;
  downloadVerified: boolean;
  visibleDelivery: boolean;
  pendingInteractions: number;
}

export function gradeRepositoryProof(value: RepositoryProofObservation) {
  const check = (id: string, passed: boolean, detail: string) => ({ id, passed, detail });
  const result = value.downloaded && typeof value.downloaded === "object" && !Array.isArray(value.downloaded)
    ? value.downloaded as Record<string, unknown> : null;
  return [
    check("production-conversion", value.finalAdapter === "paperclip_runner" &&
      value.originalAdapter === (value.conversion ? value.expectedLegacyAdapter : "paperclip_runner"),
      "Conversion must start with a real legacy agent and use its production runner transition."),
    check("retained-configuration", Boolean(value.configurationBefore) && value.configurationBefore === value.configurationAfter &&
      Boolean(value.instructionsBefore) && value.instructionsBefore === value.instructionsAfter && value.permissionsPreserved && value.environmentRetained,
      "Configured model, source directory, secret references, timeout, runtime settings, environment, instructions, and equivalent permissions must survive."),
    check("actual-native-runtime", value.actualModel === value.expectedModel && value.actualProvider === value.expectedProvider &&
      value.runCount === 1 && value.committedRuns === 1 && value.issueDone,
      "One actual native admission on the configured provider and model must commit the task result."),
    check("retained-repository", /^[a-f0-9]{64}\n$/.test(value.sourceBytes) && value.sourceBytes === value.currentSourceBytes && /^[a-f0-9]{40}$/.test(value.expectedCommit),
      "The independently seeded source reference must survive byte for byte in the configured checkout."),
    check("independent-result", value.downloadVerified && result !== null && Object.keys(result).sort().join(",") === "commit,reference,sourceSha256" &&
      result.reference === value.sourceBytes.trimEnd() && result.sourceSha256 === createHash("sha256").update(value.sourceBytes).digest("hex") && result.commit === value.expectedCommit,
      "Downloaded bytes must agree with the independent source-file and Git baseline."),
    check("accessible-delivery", value.visibleDelivery && value.pendingInteractions === 0,
      "The originating task must render the downloadable result with no unanswered interaction."),
  ];
}

export function repositoryConfigurationDigest(agent: Record<string, any>) {
  const config = agent.adapterConfig ?? {};
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical({ model: config.model, cwd: config.cwd,
    timeoutSec: config.timeoutSec, env: config.env, defaultEnvironmentId: agent.defaultEnvironmentId,
    runtimeConfig: agent.runtimeConfig }))).digest("hex");
}

export function repositoryProofDigest() {
  const hash = createHash("sha256");
  for (const file of ["repository-verification.ts", "repository-verification-flow.ts", "repository-conversion-setup.ts", "registered-artifact.ts", "live-fixtures.ts", "runner.spec.ts", "catalog.ts", "stock-harness.ts"])
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}
