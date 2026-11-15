import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createDb } from "@paperclipai/db";
import type { DatabaseClientOptions } from "@paperclipai/db/client";
import { encryptCheckpointParts, ROUTINE_CHECKPOINT_SAVE_SQL, routineCheckpointSaveParameters,
  type RoutineCheckpointSaveOwner, type RoutineCheckpointSaveResult } from "../native-runtime/native-runner-checkpoint-routine-save.js";

export type WriterThreadRequest =
  | { kind: "checkpoint.save"; id: number; run: string; epoch: number; owner: RoutineCheckpointSaveOwner; changed: Array<[string, string]> }
  | { kind: "close" };

export type WriterThreadReply =
  | { kind: "ready" }
  | ({ kind: "saved"; id: number } & RoutineCheckpointSaveResult)
  | { kind: "refused"; id: number; reason: "closed" | "revoked" }
  | { kind: "failed"; id: number; error: { name: string; message: string; code?: string } };

type WriterThreadData = { connectionString: string; clientOptions: DatabaseClientOptions; control: SharedArrayBuffer };

if (!isMainThread && parentPort) {
  const port = parentPort;
  const { connectionString, clientOptions, control } = workerData as WriterThreadData;
  const gate = new Int32Array(control);
  const db = createDb(connectionString, clientOptions);
  const tails = new Map<string, Promise<void>>();

  const save = async (request: Extract<WriterThreadRequest, { kind: "checkpoint.save" }>): Promise<WriterThreadReply> => {
    if (Atomics.load(gate, 0) !== 0) return { kind: "refused", id: request.id, reason: "closed" };
    if (Atomics.load(gate, 1) !== request.epoch) return { kind: "refused", id: request.id, reason: "revoked" };
    const changed = encryptCheckpointParts(request.owner, new Map(request.changed));
    const [saved] = await db.$client.unsafe<RoutineCheckpointSaveResult[]>(ROUTINE_CHECKPOINT_SAVE_SQL,
      routineCheckpointSaveParameters(request.owner, changed));
    return { kind: "saved", id: request.id, owned: saved?.owned ?? 0, written: saved?.written ?? 0 };
  };

  port.on("message", (request: WriterThreadRequest) => {
    if (request.kind === "close") {
      void Promise.allSettled([...tails.values()])
        .then(() => db.$client.end({ timeout: 1 }))
        .catch(() => undefined)
        .finally(() => port.close());
      return;
    }
    const next = (tails.get(request.run) ?? Promise.resolve())
      .then(() => save(request))
      .catch((error: unknown): WriterThreadReply => {
        const value = error as { name?: unknown; message?: unknown; code?: unknown };
        return { kind: "failed", id: request.id, error: { name: typeof value?.name === "string" ? value.name : "Error",
          message: typeof value?.message === "string" ? value.message : String(error),
          ...(typeof value?.code === "string" ? { code: value.code } : {}) } };
      })
      .then(reply => { port.postMessage(reply); });
    tails.set(request.run, next);
    void next.then(() => { if (tails.get(request.run) === next) tails.delete(request.run); });
  });

  void db.$client.unsafe("select 1").catch(() => undefined).finally(() => port.postMessage({ kind: "ready" } satisfies WriterThreadReply));
}
