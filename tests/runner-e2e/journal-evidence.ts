import { lstat, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
// The fixture reads bounded private evidence independently of production admission.
const MAX_JOURNAL_EVIDENCE_BYTES = 192 * 1024 * 1024;
const STIMULUS_OUTPUT = `journal-continuity-${"x".repeat(65_000)}\n`;
const STIMULUS_DIGEST = `sha256:${createHash("sha256").update(STIMULUS_OUTPUT).digest("hex")}`;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Count independently completed process calls, never repeated receipts or prose. */
export function completedJournalStimulusCalls(events: unknown[], runId: string): number {
  const starts = new Map<string, { name: unknown; sourceSeq: number }>();
  const completed = new Set<string>();
  const executions = events.map(object).filter(event => {
    const payload = object(event.payload);
    return event.schema === "paperclip.prp.event.v1" && event.runId === runId && event.sourceKind === "runner" &&
      typeof event.sourceInstanceId === "string" && typeof event.normalizedSessionId === "string" &&
      Number.isSafeInteger(event.sourceSeq) && Number(event.sourceSeq) > 0 && payload.schema === "paperclip.tool.execution.v1" &&
      payload.transport === "process" && payload.operation === "execute" && typeof payload.executionId === "string" &&
      typeof payload.name === "string";
  });
  const key = (event: Record<string, unknown>) => JSON.stringify([event.sourceInstanceId, event.normalizedSessionId, object(event.payload).executionId]);
  for (const event of executions) {
    const payload = object(event.payload);
    if (event.eventType === "tool.execution.started" && payload.status === "running") {
      starts.set(key(event), { name: payload.name, sourceSeq: Number(event.sourceSeq) });
    }
  }
  for (const event of executions) {
    const payload = object(event.payload);
    const start = starts.get(key(event));
    if (event.eventType === "tool.execution.completed" && start && start.sourceSeq < Number(event.sourceSeq) &&
      payload.name === start.name && payload.status === "completed" && payload.exitCode === 0 &&
      payload.outputBytes === Buffer.byteLength(STIMULUS_OUTPUT) && payload.outputDigest === STIMULUS_DIGEST) {
      completed.add(key(event));
    }
  }
  return completed.size;
}

/** Read-only boundary and execution oracle; raw journal contents stay private. */
export async function largeJournalEvidence(input: {
  stateRoot: string;
  runId: string;
  minimumBytes: number;
  minimumCompletedStimulusCalls: number;
}): Promise<{ journalBytes: number; minimumBytes: number; completedStimulusCalls: number; minimumCompletedStimulusCalls: number }> {
  const matches: Array<{ bytes: number; calls: number }> = [];
  for (const entry of await readdir(input.stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const filename = path.join(input.stateRoot, entry.name, "control-plane", "control-plane-state.json");
    const metadata = await lstat(filename).catch(() => null);
    if (!metadata?.isFile() || metadata.size > MAX_JOURNAL_EVIDENCE_BYTES) continue;
    const state = JSON.parse(await readFile(filename, "utf8")) as {
      schema?: string;
      identity?: { runId?: string };
      committedEvents?: unknown[];
    };
    if (state.schema === "paperclip.runner.durable.control-plane-state.v1" && state.identity?.runId === input.runId) {
      const events = (state.committedEvents ?? []).map(entry => object(object(entry).envelope).payload);
      matches.push({ bytes: metadata.size, calls: completedJournalStimulusCalls(events, input.runId) });
    }
  }
  if (matches.length !== 1 || matches[0]!.bytes <= input.minimumBytes) {
    throw new Error(`Large-journal boundary not reached: expected one matching journal above ${input.minimumBytes} bytes; observed ${JSON.stringify(matches)}`);
  }
  if (matches[0]!.calls < input.minimumCompletedStimulusCalls) {
    throw new Error(`Large-journal stimulus incomplete: expected at least ${input.minimumCompletedStimulusCalls} completed calls; observed ${matches[0]!.calls}`);
  }
  return { journalBytes: matches[0]!.bytes, minimumBytes: input.minimumBytes, completedStimulusCalls: matches[0]!.calls, minimumCompletedStimulusCalls: input.minimumCompletedStimulusCalls };
}
