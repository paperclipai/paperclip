import { describe, expect, it } from "vitest";
import { gradeWarmManagedFiles } from "./warm-managed-files.js";
describe("managed warm file oracle", () => {
  const good = { turn: 2, nonce: "test", content: "T1-test\nT2-test\n", binary: Buffer.alloc(8388608, 93), deletedStatus: 404, native: true,
    save: { state: "saved", contract: "agent_files", checkpointStats: { copiedBytes: 16, copiedFiles: 1, hashedBytes: 16 } } };
  it("accepts independently saved bytes with an incremental receipt", () => expect(gradeWarmManagedFiles(good).passed).toBe(true));
  it.each([
    { content: "T1-test\n" }, { binary: Buffer.from("claimed image") }, { deletedStatus: 200 }, { save: undefined },
    { save: { ...good.save, checkpointStats: { copiedBytes: 8388624, copiedFiles: 2, hashedBytes: 8388624 } } },
  ])("rejects missing, stale, deleted, or fully recopied data", wrong => expect(gradeWarmManagedFiles({ ...good, ...wrong }).passed).toBe(false));
});
