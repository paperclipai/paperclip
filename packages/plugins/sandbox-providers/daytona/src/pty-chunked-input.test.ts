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
  it("sends a payload below the cap as exactly one send", async () => {
    const recorder = createByteRecorder();

    await sendPtyInputInChunks(recorder.sendInput, "a small frame\n");

    expect(recorder.chunks).toHaveLength(1);
    expect(recorder.chunks[0]?.length).toBeLessThanOrEqual(PTY_MESSAGE_CAP_BYTES);
  });

  it("splits a payload above the cap into more than one send, each at or below the cap", async () => {
    const recorder = createByteRecorder();
    // A fixed payload well above the provider message cap. It stays fixed, so a
    // raised chunk size above this size makes the payload one send and fails this
    // test.
    const payload = new Uint8Array(150_416).fill(65);

    await sendPtyInputInChunks(recorder.sendInput, payload);

    expect(recorder.chunks.length).toBeGreaterThan(1);
    for (const chunk of recorder.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(PTY_INPUT_CHUNK_BYTES);
      expect(chunk.length).toBeLessThanOrEqual(PTY_MESSAGE_CAP_BYTES);
    }
    expect(concatChunks(recorder.chunks)).toEqual(payload);
  });

  it("slices a multi-byte character across a boundary by bytes and rejoins it", async () => {
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

    await sendPtyInputInChunks(recorder.sendInput, text);

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

  it("resolves each send before it starts the next send", async () => {
    let active = 0;
    let maxActive = 0;
    const sendCount = { value: 0 };
    // A `sendInput` that stays active across a microtask. The awaited loop starts
    // the next send only after the previous send resolves, so at most one send is
    // active at a time. A synchronous burst would start every send at once.
    const sendInput = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      sendCount.value += 1;
      active -= 1;
    };
    // Three chunks of the byte cap plus a short tail.
    const payload = new Uint8Array(PTY_INPUT_CHUNK_BYTES * 3 + 10).fill(65);

    await sendPtyInputInChunks(sendInput, payload);

    expect(sendCount.value).toBe(4);
    expect(maxActive).toBe(1);
  });

  it("stops sending later chunks after a chunk rejects", async () => {
    const chunks: Uint8Array[] = [];
    let errorCount = 0;
    // A `sendInput` that records the chunk, then rejects on a later microtask. The
    // rejection is asynchronous, so a synchronous burst could not stop the later
    // sends. The awaited loop learns the rejection before the next send, so it
    // sends one chunk only.
    const sendInput = async (chunk: Uint8Array): Promise<void> => {
      chunks.push(chunk);
      await Promise.resolve();
      throw new Error("RAW-PROVIDER-BROKEN-PIPE");
    };

    // A payload above the cap, so the chunker would fire more than one chunk with
    // no fail-fast. The loop stops after the first rejected chunk.
    await sendPtyInputInChunks(sendInput, new Uint8Array(150_416).fill(65), () => {
      errorCount += 1;
    });

    // The loop sent one chunk, learned the rejection, and started no later send.
    expect(chunks).toHaveLength(1);
    // The error handler ran one time for the whole payload.
    expect(errorCount).toBe(1);
  });
});
