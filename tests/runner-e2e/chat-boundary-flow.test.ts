import { describe, expect, it } from "vitest";
import { loadChatCatalogImplementation, loadIdentityBoundaryImplementation, type ChatCatalogDescriptor } from "./chat-catalog-registry.js";
import { chatBoundaryFingerprint } from "./chat-boundary-fingerprint.js";
import { assertChatCatalogFingerprintLane } from "./chat-catalog-fingerprint.js";
import type { MatrixExecution } from "./types.js";
const descriptor: ChatCatalogDescriptor = { scenarioId: "onboarding.new-instance", journeyKind: "browser-boundary", boundaryTarget: "empty-installed-target",
  modulePath: "./chat-catalog-domains/identity-onboarding.js", exportName: "boundaryCases", sourceFiles: ["chat-catalog-domains/identity-onboarding.ts"],
  oracleVersion: "boundary-test.v1", expectedRunCount: 0, expectedHumanMessageCount: 0, turnTimeoutMs: 1_000, attemptTimeoutMs: 120_000 };
const runtime = () => ({ ...descriptor, run: async () => ({}), grade: () => ({ passed: false, checks: [{ id: "full-wizard", passed: false, detail: "Calibration only, never a registered outcome." }] }), cleanup: async () => {} });
describe("separate browser boundary dispatch", () => {
  it("requires executable outcome, grader, cleanup and matching metadata", async () => {
    const importer = async () => ({ boundaryCases: [runtime()] });
    await expect(loadIdentityBoundaryImplementation(descriptor, importer)).resolves.toMatchObject({ journeyKind: "browser-boundary" });
    await expect(loadIdentityBoundaryImplementation(descriptor, async () => ({ boundaryCases: [{ ...runtime(), cleanup: undefined }] }))).rejects.toThrow("cleanup");
    await expect(loadIdentityBoundaryImplementation(descriptor, async () => ({ boundaryCases: [{ ...runtime(), expectedRunCount: 1 }] }))).rejects.toThrow("drift");
    await expect(loadIdentityBoundaryImplementation({ ...descriptor, expectedRunCount: 1 }, importer)).rejects.toThrow("zero agent admissions");
  });
  it("does not admit ordinary scenarios or evaluate boundary modules in ordinary chat dispatch", async () => {
    await expect(loadIdentityBoundaryImplementation({ ...descriptor, scenarioId: "tasks.create-backlog" })).rejects.toThrow("explicit catalog browser boundaries");
    let imported = false;
    await expect(loadChatCatalogImplementation(descriptor, async () => { imported = true; return {}; })).rejects.toThrow("ordinary Agent Chat");
    expect(imported).toBe(false);
  });
  it("admits disabled Agent Chat only on the real owned authenticated target with zero dispatch", async () => {
    const disabled: ChatCatalogDescriptor = { ...descriptor, scenarioId: "agent-chat.chat-disabled", boundaryTarget: "authenticated-harness", authentication: "human-session" };
    const implementation = { ...runtime(), ...disabled };
    const importer = async () => ({ boundaryCases: [implementation] });
    await expect(loadIdentityBoundaryImplementation(disabled, importer)).resolves.toMatchObject({ scenarioId: "agent-chat.chat-disabled" });
    await expect(loadIdentityBoundaryImplementation({ ...disabled, boundaryTarget: "empty-installed-target" }, importer)).rejects.toThrow("owned authenticated company");
    await expect(loadIdentityBoundaryImplementation({ ...disabled, authentication: "local-trusted" }, importer)).rejects.toThrow("owned authenticated company");
    await expect(loadIdentityBoundaryImplementation({ ...disabled, expectedRunCount: 1 }, importer)).rejects.toThrow("zero agent admissions");
  });
  it("requires actual installed identity and keeps the existing chat-only lane closed", () => {
    const execution = { id: "boundary", suite: { id: "chat-features" }, environment: { id: "local" } } as MatrixExecution;
    expect(() => chatBoundaryFingerprint(descriptor, execution, {})).toThrow("immutable installed CLI and server identity pins");
    expect(() => assertChatCatalogFingerprintLane({ suiteId: "chat-features", flow: "browser-boundary", environment: "local" }, {})).toThrow("source-local Agent Chat");
  });
});
