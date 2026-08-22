import { describe, expect, it } from "vitest";
import {
  PTY_INPUT_CHUNK_BYTES,
  PTY_MESSAGE_CAP_BYTES,
  sendPtyInputInChunks,
} from "./pty-chunked-input.js";

/**
 * A fake `sendInput`. It records each raw byte chunk, so a test asserts the chunk
 * count, the chunk sizes, and the rejoined bytes. It copies each chunk, because
 * the chunker passes a `subarray` view of one shared byte array.
 */
function createByteRecorder(): {
  sendInput: (chunk: Uint8Array) => Promise<void>;
  chunks: Uint8Array[];
} {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    async sendInput(chunk: Uint8Array): Promise<void> {
      chunks.push(Uint8Array.from(chunk));
    },
  };
}

/** Concatenate the recorded chunks into one byte array. */
function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

describe("sendPtyInputInChunks", () => {
  it("sends a payload below the cap as exactly one send", () => {
    const recorder = createByteRecorder();

    sendPtyInputInChunks(recorder.sendInput, "a small frame\n");

    expect(recorder.chunks).toHaveLength(1);
    expect(recorder.chunks[0]?.length).toBeLessThanOrEqual(PTY_MESSAGE_CAP_BYTES);
  });

  it("splits a payload above the cap into more than one send, each at or below the cap", () => {
    const recorder = createByteRecorder();
    // A fixed payload well above the provider message cap. It stays fixed, so a
    // raised chunk size above this size makes the payload one send and fails this
    // test.
    const payload = new Uint8Array(150_416).fill(65);

    sendPtyInputInChunks(recorder.sendInput, payload);

    expect(recorder.chunks.length).toBeGreaterThan(1);
    for (const chunk of recorder.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(PTY_INPUT_CHUNK_BYTES);
      expect(chunk.length).toBeLessThanOrEqual(PTY_MESSAGE_CAP_BYTES);
    }
    expect(concatChunks(recorder.chunks)).toEqual(payload);
  });

  it("slices a multi-byte character across a boundary by bytes and rejoins it", () => {
    const recorder = createByteRecorder();
    // A fixed payload: one 1-byte "x", then the 3-byte character "€" repeated. It
    // stays fixed, so a raised chunk size above this size makes the payload one
    // send and fails this test. The chunk size is a multiple of 3, so a pure "€"
    // run would put every boundary on a character edge. The 1-byte prefix shifts
    // the "€" run by one byte, so the first chunk boundary lands inside one "€"
    // sequence.
    const text = `x${"€".repeat(30_000)}`;
    const inputBytes = new TextEncoder().encode(text);
    expect(inputBytes.length).toBe(90_001);

    sendPtyInputInChunks(recorder.sendInput, text);

    expect(recorder.chunks.length).toBeGreaterThan(1);
    // The first chunk holds exactly the byte cap and ends inside a "€" sequence,
    // because the 1-byte prefix shifts the 3-byte run off the cap boundary. A
    // character-index slice could never end mid-sequence, so the slice is by bytes.
    expect(recorder.chunks[0]?.length).toBe(PTY_INPUT_CHUNK_BYTES);
    // The rejoined bytes equal the input bytes, so a split multi-byte sequence is
    // whole again. A streaming decoder on the read side then decodes it.
    const joined = concatChunks(recorder.chunks);
    expect(joined).toEqual(inputBytes);
    expect(new TextDecoder("utf-8").decode(joined)).toBe(text);
  });

  it("reports the first rejected chunk one time", async () => {
    const chunks: Uint8Array[] = [];
    let errorCount = 0;
    const sendInput = async (chunk: Uint8Array): Promise<void> => {
      chunks.push(chunk);
      throw new Error("RAW-PROVIDER-BROKEN-PIPE");
    };

    // A payload above the cap, so the chunker fires more than one chunk. Every
    // chunk rejects, but the error handler runs one time.
    sendPtyInputInChunks(sendInput, new Uint8Array(150_416).fill(65), () => {
      errorCount += 1;
    });
    // Let the rejected sends settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorCount).toBe(1);
  });
});
