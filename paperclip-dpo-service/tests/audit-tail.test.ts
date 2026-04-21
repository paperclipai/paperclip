import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTailer } from "../src/audit-tail.js";

describe("AuditTailer", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dpo-tail-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns new lines on each poll", () => {
    const file = join(dir, "dpo-2026-04-21.jsonl");
    writeFileSync(file, JSON.stringify({ ts: "2026-04-21T10:00:00Z", blocked: false }) + "\n");
    const tailer = new AuditTailer({ dir, day: "2026-04-21" });
    const first = tailer.poll();
    expect(first).toHaveLength(1);
    appendFileSync(file, JSON.stringify({ ts: "2026-04-21T10:05:00Z", blocked: true, blockedReason: "art_9_data_detected" }) + "\n");
    const second = tailer.poll();
    expect(second).toHaveLength(1);
    expect(second[0].blockedReason).toBe("art_9_data_detected");
    const third = tailer.poll();
    expect(third).toHaveLength(0);
  });

  it("returns empty array when file does not exist", () => {
    const tailer = new AuditTailer({ dir, day: "2026-04-21" });
    expect(tailer.poll()).toEqual([]);
  });

  it("skips malformed lines", () => {
    const file = join(dir, "dpo-2026-04-21.jsonl");
    writeFileSync(file, "not-json\n" + JSON.stringify({ ts: "x", blocked: false }) + "\n");
    const tailer = new AuditTailer({ dir, day: "2026-04-21" });
    const entries = tailer.poll();
    expect(entries).toHaveLength(1);
  });

  it("switches to new day's file when date changes", () => {
    const file1 = join(dir, "dpo-2026-04-21.jsonl");
    const file2 = join(dir, "dpo-2026-04-22.jsonl");
    writeFileSync(file1, JSON.stringify({ ts: "2026-04-21T23:59:00Z", blocked: false }) + "\n");
    writeFileSync(file2, JSON.stringify({ ts: "2026-04-22T00:01:00Z", blocked: true, blockedReason: "art_9_data_detected" }) + "\n");
    let day = "2026-04-21";
    const tailer = new AuditTailer({ dir, now: () => new Date(`${day}T12:00:00Z`) });
    expect(tailer.poll()).toHaveLength(1);
    // roll over
    day = "2026-04-22";
    const entries = tailer.poll();
    expect(entries).toHaveLength(1);
    expect(entries[0].blockedReason).toBe("art_9_data_detected");
  });
});
