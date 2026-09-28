import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeMuseRecord } from "./records.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/__fixtures__");
const lines = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), "utf8").split(/\r?\n/).filter(Boolean);

describe("decodeMuseRecord", () => {
  it("decodes every fixture line", () => {
    for (const name of ["exec-basic.jsonl", "exec-tool.jsonl", "exec-badkey.jsonl"]) {
      for (const line of lines(name)) {
        const record = decodeMuseRecord(line);
        expect(record).not.toBeNull();
        expect(record!.payloadType.length).toBeGreaterThan(0);
      }
    }
  });

  it("exposes the session stream id and payload", () => {
    const record = decodeMuseRecord(lines("exec-basic.jsonl")[0]!)!;
    expect(record.streamId).toBe("01a0df95-ddaf-7cd0-91f4-246c59f925e8");
    expect(record.recordType).toBe("reconciliation");
    expect(record.payloadType).toBe("runtime.command.accepted");
  });

  it("returns null for non-JSON, non-object and envelope-less lines", () => {
    expect(decodeMuseRecord("muse: workspace root: /x")).toBeNull();
    expect(decodeMuseRecord("[1,2]")).toBeNull();
    expect(decodeMuseRecord(JSON.stringify({ type: "text" }))).toBeNull();
    expect(decodeMuseRecord("")).toBeNull();
  });
});
