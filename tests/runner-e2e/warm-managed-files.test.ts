import { describe, expect, it } from "vitest";
import type { RunnerApi } from "./api.js";
import { gradeWarmManagedFiles, warmManagedFileEvidence } from "./warm-managed-files.js";
describe("managed warm file oracle", () => {
  const good = { turn: 2, nonce: "test", content: "T1-test\nT2-test\n", binary: Buffer.alloc(8388608, 93), deletedStatus: 404, native: true,
    save: { state: "saved", contract: "agent_files", checkpointStats: { copiedBytes: 16, copiedFiles: 1, hashedBytes: 16 } } };
  it("accepts independently saved bytes with an incremental receipt", () => expect(gradeWarmManagedFiles(good).passed).toBe(true));
  it.each([
    { content: "T1-test\n" }, { content: "T1-test\\nT2-test\\n" },
    { binary: Buffer.from("claimed image") }, { deletedStatus: 200 }, { save: undefined },
    { save: { ...good.save, checkpointStats: { copiedBytes: 8388624, copiedFiles: 2, hashedBytes: 8388624 } } },
  ])("rejects missing, stale, deleted, or fully recopied data", wrong => expect(gradeWarmManagedFiles({ ...good, ...wrong }).passed).toBe(false));
});

describe("managed warm file receipt evidence", () => {
  const saved = { state: "saved", contract: "agent_files", errorCode: null,
    checkpointStats: { copiedFiles: 3, copiedBytes: 8388625, hashedBytes: 8389685 } };
  type Event = { seq: number; runId: string; eventType: string; payload?: unknown };
  const receipt = (seq: number, payload: unknown = saved): Event => ({ seq, runId: "warm-run", eventType: "instruction_save", payload });
  function fixtureApi(events: Event[], summary: unknown = { instructionSave: saved }) {
    const requestedPages: number[] = [];
    const api = {
      async get(path: string) {
        if (path.includes("instructions-bundle")) return { content: "T1-test\n" };
        if (path.includes("/events?")) {
          const after = Number(new URL(path, "http://fixture.invalid").searchParams.get("afterSeq"));
          requestedPages.push(after);
          return events.filter(event => event.seq > after).slice(0, 1000);
        }
        return { resultJson: summary };
      },
      request: { async get(path: string) {
        return { ok: () => true, status: () => 200,
          body: async () => path.includes("unchanged.bin") ? Buffer.alloc(8388608, 93) : Buffer.from("temporary") };
      } },
    } as unknown as RunnerApi;
    return { api, requestedPages };
  }
  const capture = (api: RunnerApi) => warmManagedFileEvidence(api, "agent", "warm-run", 1, "test", true);

  it("reads the durable save receipt when terminal result metadata omits it", async () => {
    const { api } = fixtureApi([receipt(297)], {});
    expect((await capture(api)).passed).toBe(true);
  });

  it("reads all event pages before selecting the latest receipt", async () => {
    const filler = Array.from({ length: 1000 }, (_, index) => ({ seq: index + 1, runId: "warm-run", eventType: "item.delta" }));
    const { api, requestedPages } = fixtureApi([...filler, receipt(1001)], {});
    expect((await capture(api)).passed).toBe(true);
    expect(requestedPages).toEqual([0, 1000]);
  });

  it.each([
    [],
    [receipt(1), receipt(2, { ...saved, state: "pending_collection" })],
    [receipt(1), receipt(2, { ...saved, errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE" })],
    [receipt(1), receipt(2, { ...saved, checkpointStats: { copiedFiles: 1, copiedBytes: 8 } })],
  ])("rejects missing or superseded evidence even when the run summary claims success", async (...events) => {
    const { api } = fixtureApi(events);
    expect((await capture(api)).passed).toBe(false);
  });

  it("rejects a receipt returned for a different run", async () => {
    const { api } = fixtureApi([{ ...receipt(1), runId: "another-run" }]);
    await expect(capture(api)).rejects.toThrow("different run");
  });
});
