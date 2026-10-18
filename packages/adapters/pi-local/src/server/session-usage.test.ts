import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPiSessionUsage } from "./session-usage.js";

interface Message {
  role: string;
  usage?: Record<string, unknown>;
  provider?: string;
  model?: string;
  content?: string;
}

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-session-usage-"));
});
afterEach(async () => {
  await fs.rm(directory, { force: true, recursive: true });
});

async function writeSession(name: string, records: Array<Record<string, unknown>>) {
  const file = path.join(directory, name);
  const lines = records.map((record) => JSON.stringify(record));
  await fs.writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

function sessionHeader(id = "01a12a02-0be5-766f-8862-888d486834e6") {
  return { type: "session", version: 3, id, timestamp: "2026-10-11T05:00:00.000Z", cwd: "/tmp" };
}

function assistantMessage(id: string, timestamp: string, usage: Record<string, unknown> | null, extra: Partial<Message> = {}) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: "ok",
      provider: "test-provider",
      model: "test-model",
      ...(usage === null ? {} : { usage }),
      ...extra,
    },
  };
}

const usage = (input: number, cacheRead: number, output: number, cost: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + cacheRead + output,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

describe("readPiSessionUsage", () => {
  it("sums the usage of every completed assistant message and its cost", async () => {
    const file = await writeSession("full.jsonl", [
      sessionHeader(),
      assistantMessage("m1", "2026-10-11T05:01:00.000Z", usage(100, 20, 10, 0.5)),
      assistantMessage("m2", "2026-10-11T05:02:00.000Z", usage(200, 30, 20, 1.25)),
    ]);
    const summary = await readPiSessionUsage(file);
    expect(summary).not.toBeNull();
    expect(summary!.responses).toBe(2);
    expect(summary!.usage).toEqual({ inputTokens: 300, cachedInputTokens: 50, cacheWriteTokens: 0, outputTokens: 30 });
    expect(summary!.costUsd).toBeCloseTo(1.75, 10);
    expect(summary!.provider).toBe("test-provider");
    expect(summary!.model).toBe("test-model");
    expect(summary!.firstMessageAt).toBe("2026-10-11T05:01:00.000Z");
    expect(summary!.lastMessageAt).toBe("2026-10-11T05:02:00.000Z");
  });

  it("leaves out a partial in-flight turn by skipping assistant messages without usage", async () => {
    const file = await writeSession("partial.jsonl", [
      sessionHeader(),
      assistantMessage("m1", "2026-10-11T05:01:00.000Z", usage(100, 20, 10, 0.5)),
      // A turn the provider never finished has no usage record.
      assistantMessage("m2", "2026-10-11T05:02:00.000Z", null),
    ]);
    const summary = await readPiSessionUsage(file);
    expect(summary!.responses).toBe(1);
    expect(summary!.usage.inputTokens).toBe(100);
    expect(summary!.usage.outputTokens).toBe(10);
  });

  it("deduplicates replayed records by the session record id", async () => {
    const message = assistantMessage("m1", "2026-10-11T05:01:00.000Z", usage(100, 20, 10, 0.5));
    const file = await writeSession("dup.jsonl", [sessionHeader(), message, message]);
    const summary = await readPiSessionUsage(file);
    expect(summary!.responses).toBe(1);
    expect(summary!.usage.inputTokens).toBe(100);
  });

  it("attributes only messages inside the run window, so a resumed session cannot double-count earlier turns", async () => {
    const file = await writeSession("window.jsonl", [
      sessionHeader(),
      assistantMessage("earlier", "2026-10-11T04:00:00.000Z", usage(1000, 0, 100, 9)),
      assistantMessage("inside", "2026-10-11T05:10:00.000Z", usage(100, 20, 10, 0.5)),
      assistantMessage("later", "2026-10-11T06:00:00.000Z", usage(2000, 0, 200, 19)),
    ]);
    const summary = await readPiSessionUsage(file, {
      from: "2026-10-11T05:00:00.000Z",
      to: "2026-10-11T05:59:59.000Z",
    });
    expect(summary!.responses).toBe(1);
    expect(summary!.usage.inputTokens).toBe(100);
    expect(summary!.costUsd).toBeCloseTo(0.5, 10);
  });

  it("keeps costUsd null when any message lacks a usable cost instead of guessing a partial price", async () => {
    const file = await writeSession("uncosted.jsonl", [
      sessionHeader(),
      assistantMessage("m1", "2026-10-11T05:01:00.000Z", { input: 100, output: 10, cacheRead: 0 }),
      assistantMessage("m2", "2026-10-11T05:02:00.000Z", usage(50, 0, 5, 0.25)),
    ]);
    const summary = await readPiSessionUsage(file);
    expect(summary!.responses).toBe(2);
    expect(summary!.usage.inputTokens).toBe(150);
    expect(summary!.costUsd).toBeNull();
  });

  it("returns null for a missing file and for a file without a session header", async () => {
    expect(await readPiSessionUsage(path.join(directory, "missing.jsonl"))).toBeNull();
    const notSession = await writeSession("not-session.jsonl", [assistantMessage("m1", "2026-10-11T05:01:00.000Z", usage(1, 0, 1, 0))]);
    expect(await readPiSessionUsage(notSession)).toBeNull();
    expect(await readPiSessionUsage("  ")).toBeNull();
  });
});
