import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeUtf8Content, readUtf8ContentFile } from "../commands/client/common.js";

const tempFiles: string[] = [];

function tempFile(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-utf8-"));
  const filePath = path.join(dir, "body.md");
  fs.writeFileSync(filePath, bytes);
  tempFiles.push(dir);
  return filePath;
}

afterEach(() => {
  for (const dir of tempFiles.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readUtf8ContentFile", () => {
  it("reads valid UTF-8 content, including non-ASCII text", async () => {
    const text = "Relatório diário — ação, memória, café ☕";
    const filePath = tempFile(Buffer.from(text, "utf8"));
    await expect(readUtf8ContentFile(filePath)).resolves.toBe(text);
  });

  it("reads plain ASCII content", async () => {
    const filePath = tempFile(Buffer.from("hello world", "utf8"));
    await expect(readUtf8ContentFile(filePath)).resolves.toBe("hello world");
  });

  it("rejects files with legacy ANSI (cp1252) bytes instead of storing U+FFFD", async () => {
    // "ação café memória" as written by Windows PowerShell 5.1 Set-Content
    // (default ANSI code page): ç=0xE7, ã=0xE3, é=0xE9, ó=0xF3.
    const cp1252 = Buffer.from([
      0x61, 0xe7, 0xe3, 0x6f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x20, 0x6d, 0x65,
      0x6d, 0xf3, 0x72, 0x69, 0x61,
    ]);
    const filePath = tempFile(cp1252);
    await expect(readUtf8ContentFile(filePath)).rejects.toThrow(/not valid UTF-8/);
  });

  it("rejects UTF-16 files (BOM) rather than uploading mangled text", async () => {
    const filePath = tempFile(Buffer.from("﻿ação", "utf16le"));
    await expect(readUtf8ContentFile(filePath)).rejects.toThrow(/not valid UTF-8/);
  });
});

describe("decodeUtf8Content", () => {
  it("decodes valid UTF-8 buffers (stdin path)", () => {
    expect(decodeUtf8Content(Buffer.from("ação — memória", "utf8"), "stdin content")).toBe("ação — memória");
  });

  it("rejects invalid UTF-8 buffers with the source label in the error", () => {
    const cp1252 = Buffer.from([0x61, 0xe7, 0xe3, 0x6f]);
    expect(() => decodeUtf8Content(cp1252, "stdin content")).toThrow(/stdin content is not valid UTF-8/);
  });
});
