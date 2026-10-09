import { createHash } from "node:crypto";
import type { RunnerApi } from "./api.js";

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function gradeWarmManagedFiles(input: {
  turn: number; nonce: string; content: unknown; binary: Buffer; deletedStatus: number; save: unknown; native: boolean;
}) {
  const expected = `${Array.from({ length: input.turn }, (_, i) => `T${i + 1}-${input.nonce}`).join("\n")}\n`;
  const expectedBinary = Buffer.alloc(8 * 1024 * 1024, 93);
  const save = record(input.save), stats = record(save.checkpointStats);
  const checks = [
    { id: "managed-memory-exact", passed: input.content === expected },
    { id: "managed-binary-exact", passed: input.binary.equals(expectedBinary) },
    { id: "managed-deletion", passed: input.deletedStatus === (input.turn === 1 ? 200 : 404) },
    { id: "managed-save-receipt", passed: save.state === "saved" && save.contract === "agent_files" && !save.errorCode },
    ...(input.native ? [{ id: "incremental-payload", passed: typeof stats.copiedFiles === "number" &&
      (input.turn === 1 ? stats.copiedFiles === 3 && stats.copiedBytes === expectedBinary.length + Buffer.byteLength(expected) + 9
        : stats.copiedFiles === 1 && stats.copiedBytes === Buffer.byteLength(expected) && stats.hashedBytes === Buffer.byteLength(expected)) }] : []),
  ];
  return { passed: checks.every(c => c.passed), checks, expected, binaryBytes: input.binary.length,
    binarySha256: createHash("sha256").update(input.binary).digest("hex"), save };
}
export async function warmManagedFileEvidence(api: RunnerApi, agentId: string, runId: string, turn: number, nonce: string, native: boolean) {
  const base = `/api/agents/${agentId}/instructions-bundle/file?path=`;
  const note = await api.get<{ content: string }>(`${base}notes%2Fwarm-memory.txt`);
  const binary = await api.request.get(`${base}notes%2Funchanged.bin&download=true`);
  if (!binary.ok()) throw new Error(`Managed binary download failed: ${binary.status()}`);
  const deleted = await api.request.get(`${base}notes%2Fdelete-me.txt&download=true`);
  const run = await api.get<{ resultJson?: unknown }>(`/api/heartbeat-runs/${runId}`);
  return gradeWarmManagedFiles({ turn, nonce, content: note.content, binary: await binary.body(), deletedStatus: deleted.status(),
    save: record(run.resultJson).instructionSave, native });
}
