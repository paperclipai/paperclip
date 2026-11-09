import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { RunLogStore } from "../run-log-store.js";
import { readRecoverableRunLog } from "./native-run-log-recovery.js";

describe("recoverable run log reads", () => {
  it("lets the client log poll be shed under load and keeps the caller's options", async () => {
    const read = vi.fn(async () => ({ content: "", nextOffset: 0 }));
    const store = { read } as unknown as RunLogStore;
    const handle = { store: "local_file" as const, logRef: "logs/run.ndjson" };
    const signal = new AbortController().signal;
    await readRecoverableRunLog({} as Db, store, handle, { offset: 12, limitBytes: 64, signal });
    expect(read).toHaveBeenCalledWith(handle, {
      priority: "interactive",
      offset: 12,
      limitBytes: 64,
      signal,
    });
  });
});
