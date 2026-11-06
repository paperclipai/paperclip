import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { publishInvitationSourceProof, invitationSourceProofPath, verifyInvitationSourceProof, validateInvitationSourceProof } from "./identity-invite-source-proof.js";
import { runnerE2ETypeScriptProcessArgs } from "../web-server-command.js";
const root = "/owned/source";
const bytes = { serverEntry: path.join(root, "server/src/index.ts"), serverEntrySha256: "a".repeat(64), redactorSha256: "b".repeat(64) };
const process = { pid: 100, parentPid: 99, processGroupId: 100, started: "Tue Oct 27 11:00:00 2026", kind: "node" };
const expected = { temporaryRoot: "/owned/private", sourceRoot: root, apiOrigin: "http://127.0.0.1:3100", attemptId: "attempt-1", executionId: "case-1" };
const proof = { schema: "invitation-source-process.v1", generation: "generation-1", ...expected, executionIds: ["case-1"],
  ...bytes, argv: runnerE2ETypeScriptProcessArgs(root, path.join(root, "tests/runner-e2e/server-entry.ts"), ["onboard", "--yes", "--run"]),
  pid: 100, parentPid: 99, processStarted: process.started, spawnedAt: "2026-10-27T11:00:00Z" };
const health = { commit: null, serverInfo: { processStartedAt: "2026-10-27T11:00:01Z" } };
describe("invitation supervisor source qualification", () => {
  it("qualifies observed source bytes, actual child/start, attempt and API boot without guessing a production SHA", () => {
    expect(() => validateInvitationSourceProof(proof, expected, bytes, process, health, "generation-1")).not.toThrow();
  });
  it.each([{ attemptId: "foreign-attempt" }, { executionIds: ["foreign-case"] }, { apiOrigin: "http://127.0.0.1:9999" },
    { sourceRoot: "/foreign/source" }, { redactorSha256: "forged-fixed-hash" }, { serverEntrySha256: "forged-entry" },
    { argv: ["arbitrary-server"] }, { pid: 101 }, { parentPid: 98 }, { processStarted: "old PID start" }])("rejects a forged or mismatched receipt %j", change => {
    expect(() => validateInvitationSourceProof({ ...proof, ...change }, expected, bytes, process, health)).toThrow("unqualified");
  });
  it("rejects replay of an old restart generation and old API boot", () => {
    expect(() => validateInvitationSourceProof(proof, expected, bytes, process, health, "generation-2")).toThrow("unqualified");
    expect(() => validateInvitationSourceProof(proof, expected, bytes, undefined, health)).toThrow("unqualified");
    expect(() => validateInvitationSourceProof(proof, expected, bytes, process, { serverInfo: { processStartedAt: "2026-10-27T10:00:00Z" } })).toThrow("unqualified");
  });
});

const processReader = vi.hoisted(() => vi.fn());
vi.mock("../process-tree.js", () => ({ readProcessTable: processReader }));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function sourceFixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "invitation-source-proof-test-"))); directories.push(directory);
  const sourceRoot = path.join(directory, "source"), temporaryRoot = path.join(directory, "private");
  await mkdir(path.join(sourceRoot, "server/src/middleware"), { recursive: true }); await mkdir(path.join(temporaryRoot, "control"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(sourceRoot, "server/src/index.ts"), "export {};\n");
  await writeFile(path.join(sourceRoot, "server/src/middleware/redact-sensitive.ts"), "export const fixture = true;\n");
  processReader.mockResolvedValue([process]);
  const expected = { temporaryRoot, sourceRoot, apiOrigin: "http://127.0.0.1:3100", attemptId: "attempt-1", executionId: "case-1" };
  const spawnedAt = new Date(Date.now() - 1000).toISOString();
  await publishInvitationSourceProof({ ...expected, executionIds: [expected.executionId], pid: 100,
    argv: runnerE2ETypeScriptProcessArgs(sourceRoot, path.join(sourceRoot, "tests/runner-e2e/server-entry.ts"), ["onboard", "--yes", "--run"]), spawnedAt });
  return { ...expected, filename: invitationSourceProofPath(temporaryRoot), health: async () => ({ commit: null, serverInfo: { processStartedAt: new Date().toISOString() } }) };
}
describe("attempt-private supervisor receipt custody", () => {
  it("re-reads real receipt bytes and rejects a forged fixed-logger claim", async () => {
    const f = await sourceFixture(); await expect(verifyInvitationSourceProof(f)).resolves.toMatchObject({ apiOrigin: f.apiOrigin });
    const receipt = JSON.parse(await readFile(f.filename, "utf8")); receipt.redactorSha256 = "forged-fixed-logger";
    await writeFile(f.filename, JSON.stringify(receipt), { mode: 0o600 });
    await expect(verifyInvitationSourceProof(f)).rejects.toThrow("unqualified");
  });
  it("rejects another attempt, a dead/reused process and an older restart receipt", async () => {
    const f = await sourceFixture(); await expect(verifyInvitationSourceProof({ ...f, attemptId: "foreign-attempt" })).rejects.toThrow("unqualified");
    processReader.mockResolvedValue([{ ...process, started: "a different process start" }]); await expect(verifyInvitationSourceProof(f)).rejects.toThrow("unqualified");
    processReader.mockResolvedValue([process]);
    await writeFile(path.join(f.temporaryRoot, "control/server-restart.ack.json"), JSON.stringify({ status: "ready", invitationSourceGeneration: "newer-generation" }));
    await expect(verifyInvitationSourceProof(f)).rejects.toThrow("unqualified");
  });
});
