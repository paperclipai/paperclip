import { expect, it, vi } from "vitest";
import { materializeCurrentAuthority, referenceCurrentAuthority } from "./current-authority-evidence.js";
import type { StoredCoreState } from "./durable-prp-control-plane.js";

it("resolves only exact current references and rejects missing, conflicting or rebound authority", async () => {
  const command = { commandId: "finish-result", controllerSeq: 12, status: "completed", type: "semantic_tool.result",
    payload: { operationId: "paperclip_finish", input: { summary: "body".repeat(10000) } }, result: { accepted: true } };
  const active = { commandId: "pending", controllerSeq: 13, status: "pending", type: "turn.start" };
  const state = { identity: { runId: "run-1" }, commands: [command, active], committedEvents: [],
    indexedState: { schema: "paperclip.runner.current-authority.v1", pendingSemanticInputIds: [] } } as unknown as StoredCoreState;
  const stored = referenceCurrentAuthority(state);
  expect(stored.commands).toEqual([active]);
  expect(JSON.stringify(stored).length).toBeLessThan(1024);
  const receipt = { epoch: "run-1", kind: "command" as const, id: command.commandId, sequence: "12", body: command };
  const read = vi.fn(async () => receipt);
  expect(await materializeCurrentAuthority(stored as unknown as Record<string, unknown>, read)).toEqual(state);
  expect(read).toHaveBeenCalledExactlyOnceWith("run-1", "command", "finish-result");
  for (const bad of [null, { ...receipt, epoch: "foreign" }, { ...receipt, id: "other" }, { ...receipt, sequence: "11" }, { ...receipt, body: { ...command, result: {} } }]) {
    await expect(materializeCurrentAuthority(stored as unknown as Record<string, unknown>, async () => bad)).rejects.toThrow("exact receipt");
  }
  const absent = structuredClone(stored);
  delete absent.indexedState!.recoveryEvidence;
  await expect(materializeCurrentAuthority(absent as unknown as Record<string, unknown>, read)).rejects.toThrow("exact receipt");
  const rebound = structuredClone(stored);
  const refs = rebound.indexedState!.recoveryEvidence!.records;
  refs["command:other"] = refs["command:terminal:paperclip_finish"]!;
  delete refs["command:terminal:paperclip_finish"];
  await expect(materializeCurrentAuthority(rebound as unknown as Record<string, unknown>, read)).rejects.toThrow("exact receipt");
});
