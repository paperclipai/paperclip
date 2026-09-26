import { describe, expect, it } from "vitest";
import { readRedactedLogContent } from "./redacted-log-read.js";

function readerFor(file: string) {
  return async (opts: { offset: number; limitBytes: number }) => {
    const start = Math.max(0, Math.min(opts.offset, Buffer.byteLength(file)));
    const end = Math.min(start + opts.limitBytes, Buffer.byteLength(file));
    return {
      content: file.slice(start, end),
      nextOffset: end < file.length ? end : undefined,
    };
  };
}

describe("readRedactedLogContent", () => {
  it("redacts a tokenized remote when the requested range ends before the at-sign", async () => {
    const token = "opaquecompanytokenvalue1234567890abcd";
    const file = [
      "line-one",
      `remote: https://${token}@github.com/paperclipai/paperclip.git`,
      "line-three",
      "",
    ].join("\n");
    const tokenAt = file.indexOf(token);
    const atSign = file.indexOf("@github.com");
    expect(atSign).toBeGreaterThan(tokenAt);

    const first = await readRedactedLogContent(readerFor(file), {
      offset: tokenAt,
      limitBytes: atSign - tokenAt,
    });

    expect(first.content).not.toContain(token);
    expect(first.content).toContain("https://***REDACTED***@github.com/paperclipai/paperclip.git");
    expect(first.nextOffset).toBeGreaterThan(atSign);

    const rest = await readRedactedLogContent(readerFor(file), {
      offset: first.nextOffset,
      limitBytes: 64,
    });
    expect(rest.content).not.toContain(token);
    expect(`${first.content}${rest.content}`).toContain("line-three");
  });

  it("pages a redacted log without dropping the following line", async () => {
    const token = "opaquecompanytokenvalue1234567890abcd";
    const file = `alpha\nhttps://${token}@github.com/org/repo.git\nomega\n`;
    const read = readerFor(file);
    let offset = 0;
    let combined = "";
    for (let page = 0; page < 6 && offset !== undefined; page += 1) {
      const result = await readRedactedLogContent(read, { offset, limitBytes: 12 });
      combined += result.content;
      if (result.nextOffset == null) break;
      expect(result.nextOffset).toBeGreaterThan(offset);
      offset = result.nextOffset;
    }

    expect(combined).not.toContain(token);
    expect(combined).toContain("alpha");
    expect(combined).toContain("omega");
    expect(combined).toContain("https://***REDACTED***@github.com/org/repo.git");
  });

  it("returns the file end when a tail would otherwise skip bytes appended later", async () => {
    const token = "opaquecompanytokenvalue1234567890abcd";
    const file = `prefix\nhttps://${token}@github.com/org/repo.git\n`;
    const offset = file.indexOf(token) + 4;
    const result = await readRedactedLogContent(readerFor(file), {
      offset,
      limitBytes: 8,
    });

    expect(result.content).not.toContain(token);
    expect(result.content).toContain("https://***REDACTED***@github.com/org/repo.git");
    const fileBytes = Buffer.byteLength(file);
    const resume = result.nextOffset ?? offset + Buffer.byteLength(result.content);
    expect(resume).toBe(fileBytes);

    const appended = `${file}tail-line\n`;
    const next = await readRedactedLogContent(readerFor(appended), {
      offset: resume,
      limitBytes: 64,
    });
    expect(next.content).toContain("tail-line");
    expect(next.content).not.toContain(token);
  });

  it("keeps a clean https URL and an ssh remote", async () => {
    const file = "see https://github.com/org/repo.git and git@github.com:org/repo.git\n";
    const result = await readRedactedLogContent(readerFor(file), { offset: 0, limitBytes: 8 });
    expect(result.content).toContain("https://github.com/org/repo.git");
    expect(result.content).toContain("git@github.com:org/repo.git");
    expect(result.nextOffset).toBeUndefined();
  });
});
