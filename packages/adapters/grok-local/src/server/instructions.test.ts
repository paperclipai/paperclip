import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGrokInstructions } from "./instructions.js";

const limit = 64 * 1024;
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-instruction-read-"));
  roots.push(root);
  return path.join(root, "rules.md");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("readGrokInstructions", () => {
  it.each(["", "é".repeat(limit / 2), "🙂".repeat(limit / 4)])(
    "reads UTF-8 within the byte bound (case %#)",
    async (content) => {
      const file = await fixture();
      await fs.writeFile(file, content);
      expect(await readGrokInstructions(file)).toBe(content);
    },
  );

  it("rejects oversized sparse files before allocating or reading their contents", async () => {
    const file = await fixture();
    await fs.writeFile(file, "");
    await fs.truncate(file, 1024 * 1024 * 1024);
    const open = fs.open.bind(fs);
    const read = vi.fn();
    const close = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      read.mockImplementation(handle.read.bind(handle));
      close.mockImplementation(handle.close.bind(handle));
      handle.read = read;
      handle.close = close;
      return handle;
    });

    await expect(readGrokInstructions(file)).rejects.toThrow(/64 KiB/);
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the encoded-text limit when invalid UTF-8 expands during decoding", async () => {
    const file = await fixture();
    await fs.writeFile(file, Buffer.alloc(limit, 0x80));
    await expect(readGrokInstructions(file)).rejects.toThrow(/64 KiB/);
  });

  it("assembles short reads before decoding split multibyte characters", async () => {
    const file = await fixture();
    const content = "🙂é".repeat(200);
    await fs.writeFile(file, content);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      handle.read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) =>
        read(buffer, offset, Math.min(length, 7), position),
      ) as unknown as FileHandle["read"];
      return handle;
    });

    expect(await readGrokInstructions(file)).toBe(content);
  });

  it("bounds reads if a file grows after stat, including repeated short reads", async () => {
    const file = await fixture();
    await fs.writeFile(file, "original");
    const open = fs.open.bind(fs);
    let consumed = 0;
    const capacities: number[] = [];
    const close = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      const read = handle.read.bind(handle);
      close.mockImplementation(handle.close.bind(handle));
      handle.close = close;
      handle.stat = vi.fn(async () => {
        const before = await stat();
        await fs.writeFile(file, "é".repeat(limit));
        return before;
      }) as unknown as FileHandle["stat"];
      handle.read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        capacities.push(buffer.length);
        const result = await read(buffer, offset, Math.min(length, 997), position);
        consumed += result.bytesRead;
        return result;
      }) as unknown as FileHandle["read"];
      return handle;
    });

    await expect(readGrokInstructions(file)).rejects.toThrow(/64 KiB/);
    expect(consumed).toBe(limit + 1);
    expect(new Set(capacities)).toEqual(new Set([limit + 1]));
    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts a managed symlink and pins its opened target across replacement", async () => {
    const file = await fixture();
    const link = `${file}.link`;
    const replacement = `${file}.replacement`;
    await fs.writeFile(file, "Original target policy");
    await fs.writeFile(replacement, "Replacement policy");
    await fs.symlink(file, link);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      await fs.unlink(link);
      await fs.symlink(replacement, link);
      return handle;
    });

    expect(await readGrokInstructions(link)).toBe("Original target policy");
  });

  it("rejects non-regular targets before reading and uses nonblocking open", async () => {
    const file = await fixture();
    const open = fs.open.bind(fs);
    const read = vi.fn();
    const close = vi.fn();
    const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      read.mockImplementation(handle.read.bind(handle));
      close.mockImplementation(handle.close.bind(handle));
      handle.read = read;
      handle.close = close;
      return handle;
    });

    await expect(readGrokInstructions(path.dirname(file))).rejects.toThrow(/regular file/);
    expect(opened).toHaveBeenCalledWith(path.dirname(file), constants.O_RDONLY | constants.O_NONBLOCK);
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["stat", "read"] as const)("closes the file after a %s failure", async (operation) => {
    const file = await fixture();
    await fs.writeFile(file, "Policy");
    const open = fs.open.bind(fs);
    const close = vi.fn();
    const failure = new Error("Synthetic IO failure");
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      close.mockImplementation(handle.close.bind(handle));
      handle.close = close;
      handle[operation] = vi.fn().mockRejectedValue(failure);
      return handle;
    });

    await expect(readGrokInstructions(file)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});
