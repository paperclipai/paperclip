import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { boundaryScenarioMetadata, chatBoundaryFingerprint } from "./chat-boundary-fingerprint.js";
import { fingerprintChatDependencyClosure } from "./chat-catalog-fingerprint.js";
import { findChatCatalogCase } from "./chat-catalog-registry.js";
import type { MatrixExecution } from "./types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scenario = { id: "access.sign-in", capabilities: ["access/sign-in"], context: "An expired human session.",
  query: "Sign me back in.", expected_outcome: "Real authorized return after sign-in.", attempts: [] as unknown[] };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "boundary-metadata-fingerprint-")); roots.push(root);
  mkdirSync(path.join(root, "tests/runner-e2e"), { recursive: true });
  const manifestPath = "tests/runner-e2e/chat-campaign-manifest.json";
  const write = (file: string, body: string) => writeFileSync(path.join(root, file), body);
  write("selected.ts", 'import "./dependency.js"; export const load = (name: string) => import(name);');
  write("dependency.ts", 'export const behavior = "original";');
  const descriptor = { scenarioId: scenario.id, boundaryTarget: "authenticated-harness" };
  const manifest = { scenarios: [structuredClone(scenario)], ledger: { completed: 0 } };
  const fingerprint = () => {
    write(manifestPath, JSON.stringify(manifest));
    const frozen = boundaryScenarioMetadata(manifest, descriptor.scenarioId);
    return fingerprintChatDependencyClosure({ root, entries: ["selected.ts"], selected: { descriptor, scenario: frozen, journeyKind: "browser-boundary" },
      normalizedMetadata: { [manifestPath]: frozen } });
  };
  return { manifest, descriptor, write, fingerprint, manifestPath };
}
it("keeps ledger, attempt, result and usage updates out of the selected boundary metadata", () => {
  const f = fixture(); const before = f.fingerprint();
  f.manifest.ledger.completed++;
  f.manifest.scenarios[0]!.attempts.push({ result: { outcome: "failed", evidencePaths: ["retained/result.json"] }, usage: { tokens: 123, costUsd: null } });
  expect(f.fingerprint().digest).toBe(before.digest);
  f.manifest.scenarios.push({ ...scenario, id: "unselected.scenario", query: "Unrelated request" });
  expect(f.fingerprint().digest).toBe(before.digest);
  expect(before.unknownDynamicImports).toEqual(["selected.ts"]);
  expect(before.sources.map(row => row.file)).toContain(f.manifestPath);
});
it.each(["query", "context", "expected_outcome", "capabilities"] as const)("invalidates selected frozen %s changes", field => {
  const f = fixture(); const before = f.fingerprint().digest;
  if (field === "capabilities") f.manifest.scenarios[0]!.capabilities.push("access/changed");
  else f.manifest.scenarios[0]![field] += " Changed canonical requirement.";
  expect(f.fingerprint().digest).not.toBe(before);
});
it("fails closed for missing, wrong, duplicate or malformed selected canonical identity", () => {
  expect(() => boundaryScenarioMetadata({}, scenario.id)).toThrow("Missing");
  expect(() => boundaryScenarioMetadata({ scenarios: [scenario] }, "access.not-the-selected-id")).toThrow("Missing");
  expect(() => boundaryScenarioMetadata({ scenarios: [{ ...scenario, id: undefined }] }, scenario.id)).toThrow("Missing");
  expect(() => boundaryScenarioMetadata({ scenarios: [scenario, scenario] }, scenario.id)).toThrow("duplicate");
  expect(() => boundaryScenarioMetadata({ scenarios: [{ ...scenario, query: null }] }, scenario.id)).toThrow("Invalid");
});
it("continues to bind executable bytes, unknown-source closure and selected descriptor identity", () => {
  const f = fixture(); const before = f.fingerprint().digest;
  f.write("dependency.ts", 'export const behavior = "changed executable";');
  expect(f.fingerprint().digest).not.toBe(before);
  f.write("unknown-runtime.ts", 'export const unknown = "conservatively included";');
  const withUnknown = f.fingerprint();
  expect(withUnknown.sources.map(row => row.file)).toContain("unknown-runtime.ts");
  f.write("unknown-runtime.ts", 'export const unknown = "changed unknown code";');
  expect(f.fingerprint().digest).not.toBe(withUnknown.digest);
  const beforeDescriptor = f.fingerprint().digest;
  f.descriptor.boundaryTarget = "changed-target";
  expect(f.fingerprint().digest).not.toBe(beforeDescriptor);
});
it("wires the actual boundary lane to the selected scenario projection without dropping its closure", () => {
  const descriptor = findChatCatalogCase("access.sign-in")!;
  const execution = { id: "offline-sign-in", suite: { id: "chat-features" }, environment: { id: "local" }, requiredCredentials: [] } as unknown as MatrixExecution;
  const result = chatBoundaryFingerprint(descriptor, execution, {}, { credentialNames: [], referenceNames: [], externalRequirements: [] });
  const manifest = JSON.parse(readFileSync(new URL("./chat-campaign-manifest.json", import.meta.url), "utf8"));
  const frozen = boundaryScenarioMetadata(manifest, descriptor.scenarioId);
  const expected = createHash("sha256").update(JSON.stringify(frozen)).digest("hex");
  expect(result.sources.find(row => row.file === "tests/runner-e2e/chat-campaign-manifest.json")?.sha256).toBe(expected);
  expect(result.sources.map(row => row.file)).toEqual(expect.arrayContaining(["tests/runner-e2e/chat-boundary-fingerprint.ts", "tests/runner-e2e/runner.spec.ts", "tests/runner-e2e/launch.ts"]));
  expect(result.fingerprintKind).toBe("complete-execution-and-oracle-closure");
  expect(result.unknownDynamicImports.length).toBeGreaterThan(0);
  expect(() => chatBoundaryFingerprint(descriptor, { ...execution, environment: { id: "daytona" } } as MatrixExecution, {})).toThrow("explicitly selected local browser boundary");
});
