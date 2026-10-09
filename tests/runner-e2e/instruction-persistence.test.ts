import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gradeInstructionPersistence, instructionPersistenceTask } from "./instruction-persistence.js";
import { runnerMatrix } from "./catalog.js";
const expectedContent = "original\nInstruction persistence nonce: fixture\n";
const valid = () => ({ before: { revision: { id: "before" } },
  saveEvent: { runId: "first-run", state: "saved" }, fileProof: true,
  after: { content: expectedContent, contentHash: createHash("sha256").update(expectedContent).digest("hex"), revision: { id: "after", source: "cleanup", sourceRunId: "first-run", contentHash: createHash("sha256").update(expectedContent).digest("hex") } },
  firstRunId: "first-run", expectedContent,
  proof: { body: "Instruction persistence nonce: fixture\n", contentVerified: true },
  expectedProof: "Instruction persistence nonce: fixture\n" });
describe("instruction persistence independent oracle", () => {
  it("does not disclose the persisted nonce in the fresh-task marker", () => {
    const nonce = "only-the-instruction-entry-reveals-this";
    expect(instructionPersistenceTask.buildVisibleMarker(nonce)).not.toContain(nonce);
  });
  it("accepts exact cleanup content and a verified downloaded fresh-task proof", () => {
    expect(gradeInstructionPersistence(valid()).every(row => row.passed)).toBe(true);
  });
  it.each(["missing-save", "wrong-run", "missing-files", "wrong-bytes", "missing-proof", "unverified-proof", "wrong-proof"])("rejects %s evidence", kind => {
    const value = valid();
    if (kind === "missing-save") value.saveEvent.state = "unavailable";
    if (kind === "wrong-run") value.saveEvent.runId = "another-run";
    if (kind === "missing-files") value.fileProof = false;
    if (kind === "wrong-bytes") value.after.content = "claimed success";
    if (kind === "missing-proof") return expect(gradeInstructionPersistence({ ...value, proof: undefined }).some(row => !row.passed)).toBe(true);
    if (kind === "unverified-proof") value.proof.contentVerified = false;
    if (kind === "wrong-proof") value.proof.body = "claimed success";
    expect(gradeInstructionPersistence(value).some(row => !row.passed)).toBe(true);
  });
  it("registers exactly three explicit cells without changing scheduled campaigns", () => {
    const cells = runnerMatrix.filter(row => row.suite.id === "instruction-persistence");
    expect(cells.map(row => `${row.profile.id}.${row.environment.id}`)).toEqual(["legacy-codex.local", "runner-codex.local", "runner-codex.daytona"]);
    expect(cells.every(row => row.suite.manualOnly && row.task.expectedRunCount === 6)).toBe(true);
  });
});
