import { describe, expect, it, vi } from "vitest";
import {
  shouldStreamSafePublicationText,
  streamSafePublicationText,
} from "./chat-publication-stream.js";

describe("safe chat publication streaming", () => {
  it("reconstructs externally projected text without splitting code points", async () => {
    const source = "abc😀def";
    const chunks: string[] = [];
    for await (const chunk of streamSafePublicationText(source, {
      chunkCodePoints: 4,
      delayMs: 0,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["abc😀", "def"]);
    expect(chunks.join("")).toBe(source);
  });

  it("uses bounded pacing between chunks and never after the final chunk", async () => {
    const wait = vi.fn(async () => undefined);
    const chunks: string[] = [];
    for await (const chunk of streamSafePublicationText("abcdef", {
      chunkCodePoints: 2,
      delayMs: 25,
      wait,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["ab", "cd", "ef"]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 25);
  });

  it("streams only responses large enough to benefit", () => {
    expect(shouldStreamSafePublicationText("short")).toBe(false);
    expect(shouldStreamSafePublicationText("x".repeat(281))).toBe(true);
  });
});
