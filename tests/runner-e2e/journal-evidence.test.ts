import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { completedJournalStimulusCalls, largeJournalEvidence } from "./journal-evidence.js";

const output = `journal-continuity-${"x".repeat(65_000)}\n`;
function call(index: number) {
  const event = { schema: "paperclip.prp.event.v1", runId: "expected-run", sourceKind: "runner", sourceInstanceId: "runner", normalizedSessionId: "session" };
  const payload = { schema: "paperclip.tool.execution.v1", transport: "process", operation: "execute", executionId: `exec-${index}`, name: "python3 fixture" };
  return [
    { ...event, eventType: "tool.execution.started", sourceSeq: index * 2, payload: { ...payload, status: "running" } },
    { ...event, eventType: "tool.execution.completed", sourceSeq: index * 2 + 1, payload: { ...payload, status: "completed", exitCode: 0, outputBytes: Buffer.byteLength(output), outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}` } },
  ];
}

describe("large journal boundary evidence", () => {
  it("requires one correctly owned journal over the boundary and an independent completed-call count", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "journal-evidence-"));
    const directory = path.join(root, "a".repeat(64), "control-plane");
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, "control-plane-state.json");
    const state = { schema: "paperclip.runner.durable.control-plane-state.v1", identity: { runId: "expected-run" }, commands: [] };
    const input = { stateRoot: root, runId: "expected-run", minimumBytes: 1024, minimumCompletedStimulusCalls: 2 };
    try {
      await writeFile(filename, JSON.stringify(state));
      await expect(largeJournalEvidence(input)).rejects.toThrow("boundary not reached");
      await writeFile(filename, JSON.stringify({ ...state, commands: [{ payload: "x".repeat(2048) }] }));
      await expect(largeJournalEvidence(input)).rejects.toThrow("stimulus incomplete");
      await writeFile(filename, JSON.stringify({ ...state, committedEvents: [...call(1), ...call(2)].map(event => ({ envelope: { payload: event } })) }));
      const evidence = await largeJournalEvidence(input);
      expect(Object.keys(evidence)).toEqual(["journalBytes", "minimumBytes", "completedStimulusCalls", "minimumCompletedStimulusCalls"]);
      expect(evidence.completedStimulusCalls).toBe(2);
      await expect(largeJournalEvidence({ ...input, runId: "another-run" })).rejects.toThrow("boundary not reached");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not count repeated receipts, unmatched completion, wrong runs, failed or unrelated output", () => {
    const pair = call(1);
    expect(completedJournalStimulusCalls([...pair, ...pair], "expected-run")).toBe(1);
    expect(completedJournalStimulusCalls([pair[1]], "expected-run")).toBe(0);
    expect(completedJournalStimulusCalls(pair, "another-run")).toBe(0);
    expect(completedJournalStimulusCalls([pair[0], { ...pair[1], payload: { ...pair[1]!.payload, exitCode: 1 } }], "expected-run")).toBe(0);
    expect(completedJournalStimulusCalls([pair[0], { ...pair[1], payload: { ...pair[1]!.payload, outputDigest: "sha256:unrelated" } }], "expected-run")).toBe(0);
  });

  it("requires the same runner, session, execution and command with ordered source sequence", () => {
    const [start, complete] = call(1);
    for (const changed of [
      { ...complete, sourceInstanceId: "another-runner" },
      { ...complete, normalizedSessionId: "another-session" },
      { ...complete, sourceSeq: start!.sourceSeq },
      { ...complete, payload: { ...complete!.payload, executionId: "another-exec" } },
      { ...complete, payload: { ...complete!.payload, name: "another-command" } },
      { ...complete, payload: { ...complete!.payload, outputBytes: 1 } },
    ]) {
      expect(completedJournalStimulusCalls([start, changed], "expected-run")).toBe(0);
    }
  });
});
