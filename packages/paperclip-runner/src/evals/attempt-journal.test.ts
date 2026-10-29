import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AttemptJournal } from "./attempt-journal.js";

describe("attempt journal", () => {
  it("retains acknowledged usage before completion and rejects replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-journal-"));
    const path = join(root, "journal.jsonl");
    const journal = new AttemptJournal(path);
    try {
      journal.append({ kind: "dispatch", id: "attempt" });
      journal.append({ kind: "usage", requests: 1, costUsd: 0.02 });
      expect(readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
        { kind: "dispatch", id: "attempt" }, { kind: "usage", requests: 1, costUsd: 0.02 },
      ]);
      expect(() => new AttemptJournal(path)).toThrow();
      expect(statSync(path).mode & 0o777).toBe(0o600);
      journal.close();
      expect(() => journal.append({})).toThrow("closed");
    } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("fails before writing an over-limit record without discarding earlier evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-journal-"));
    const path = join(root, "journal.jsonl");
    const journal = new AttemptJournal(path, 16);
    try {
      journal.append({ a: 1 });
      expect(() => journal.append({ text: "too large" })).toThrow("limit");
      expect(readFileSync(path, "utf8")).toBe('{"a":1}\n');
    } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
