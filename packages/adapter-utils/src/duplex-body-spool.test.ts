import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DUPLEX_FRAME_VERSION, type DuplexBodyChunkFrame } from "./duplex-frame-codec.js";
import {
  DuplexBodyReceiver,
  type DuplexBodyReceiverConfig,
  splitBodyIntoChunkFrames,
  sweepStaleSpillDirectories,
} from "./duplex-body-spool.js";

// Read the whole reassembled body back, whatever path it took. A memory body
// returns its buffer; a spilled body streams from disk. The test uses this only
// to assert the round-trip content, never on a hot path.
async function readBodyBytes(body: {
  spilled: boolean;
  createReadStream: () => NodeJS.ReadableStream;
}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body.createReadStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

let spillRoot: string;

beforeEach(async () => {
  spillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "duplex-spool-test-"));
});

afterEach(async () => {
  await fs.rm(spillRoot, { recursive: true, force: true }).catch(() => undefined);
});

function makeReceiver(overrides: DuplexBodyReceiverConfig = {}): Promise<DuplexBodyReceiver> {
  return DuplexBodyReceiver.create({ spillRootDir: spillRoot, ...overrides });
}

const RAW = 8;

// Feed a whole body through a receiver as an envelope plus chunk frames. Return
// the settled body handle. The caller pushes the chunks the split produces.
async function transfer(
  receiver: DuplexBodyReceiver,
  id: string,
  body: Buffer,
): ReturnType<DuplexBodyReceiver["begin"]> {
  const promise = receiver.begin(id, body.length);
  const frames = splitBodyIntoChunkFrames(id, body, DUPLEX_FRAME_VERSION, RAW);
  for (const frame of frames) {
    const result = receiver.pushChunk(frame);
    expect(result.ok).toBe(true);
  }
  return promise;
}

describe("duplex body reassembler — round trip", () => {
  it("reassembles a small body on the memory path", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    const source = Buffer.from("hello duplex body");
    const body = await transfer(receiver, "req-mem", source);
    expect(body.spilled).toBe(false);
    expect(body.byteCount).toBe(source.length);
    expect(body.readMemory().equals(source)).toBe(true);
    expect((await readBodyBytes(body)).equals(source)).toBe(true);
    await body.dispose();
  });

  it("reassembles a large body on the spill path without holding it in memory", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 16, rawChunkBytes: RAW });
    const source = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789ABCD"); // 40 bytes
    const body = await transfer(receiver, "req-spill", source);
    expect(body.spilled).toBe(true);
    expect(body.byteCount).toBe(source.length);
    // A spilled body never loads the whole body into memory on the receive side.
    expect(() => body.readMemory()).toThrow();
    expect(receiver.spillUsedBytes).toBe(source.length);
    expect(receiver.spillOpenFiles).toBe(1);
    expect((await readBodyBytes(body)).equals(source)).toBe(true);
    await body.dispose();
    // The dispose path unlinks the file and releases the reservation.
    expect(receiver.spillUsedBytes).toBe(0);
    expect(receiver.spillOpenFiles).toBe(0);
    const entries = await fs.readdir(receiver.spillDir);
    expect(entries).toHaveLength(0);
    await receiver.destroy();
  });

  it("completes a zero-length body at once and accepts no chunk", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 16, rawChunkBytes: RAW });
    const body = await receiver.begin("req-zero", 0);
    expect(body.byteCount).toBe(0);
    expect(body.readMemory().length).toBe(0);
    const stray = receiver.pushChunk({
      version: DUPLEX_FRAME_VERSION,
      type: "body_chunk",
      id: "req-zero",
      seq: 0,
      data: Buffer.from("x").toString("base64"),
    });
    expect(stray.ok).toBe(false);
    if (!stray.ok) expect(stray.error.code).toBe("zero_body_has_chunk");
    await body.dispose();
  });
});

describe("duplex body reassembler — rejection matrix", () => {
  function chunk(id: string, seq: number, data: string): DuplexBodyChunkFrame {
    return { version: DUPLEX_FRAME_VERSION, type: "body_chunk", id, seq, data };
  }

  it("rejects a duplicate seq", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    void receiver.begin("d", 16);
    expect(receiver.pushChunk(chunk("d", 0, Buffer.alloc(RAW, 1).toString("base64"))).ok).toBe(true);
    const dup = receiver.pushChunk(chunk("d", 0, Buffer.alloc(RAW, 2).toString("base64")));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("seq_out_of_order");
  });

  it("rejects a gap in the seq order", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    void receiver.begin("g", 24);
    expect(receiver.pushChunk(chunk("g", 0, Buffer.alloc(RAW, 1).toString("base64"))).ok).toBe(true);
    const gap = receiver.pushChunk(chunk("g", 2, Buffer.alloc(RAW, 2).toString("base64")));
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.error.code).toBe("seq_out_of_order");
  });

  it("rejects a reordered seq", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    void receiver.begin("r", 24);
    const reorder = receiver.pushChunk(chunk("r", 1, Buffer.alloc(RAW, 1).toString("base64")));
    expect(reorder.ok).toBe(false);
    if (!reorder.ok) expect(reorder.error.code).toBe("seq_out_of_order");
  });

  it("rejects non-canonical base64", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    const begun = receiver.begin("b", 8);
    begun.catch(() => undefined);
    // "AB==" carries non-zero bits in the final sextet, so it decodes to one
    // byte and re-encodes to "AA==". The round-trip mismatch marks it not
    // canonical.
    const bad = receiver.pushChunk(chunk("b", 0, "AB=="));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("chunk_not_canonical_base64");
  });

  it("rejects a short non-final chunk (truncation)", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    void receiver.begin("t", 24);
    // A non-final chunk must be exactly RAW bytes. A 4-byte chunk that does not
    // complete the 24-byte body is a truncation.
    const truncation = receiver.pushChunk(chunk("t", 0, Buffer.alloc(4, 1).toString("base64")));
    expect(truncation.ok).toBe(false);
    if (!truncation.ok) expect(truncation.error.code).toBe("chunk_wrong_size");
  });

  it("rejects an empty non-final chunk", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    void receiver.begin("e", 16);
    const empty = receiver.pushChunk(chunk("e", 0, ""));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("empty_chunk");
  });

  it("rejects an overrun past the declared body size", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    // A 12-byte body takes one full RAW chunk, then a final chunk of 4 bytes. A
    // second full RAW chunk overruns the declared size.
    void receiver.begin("o", 12);
    expect(receiver.pushChunk(chunk("o", 0, Buffer.alloc(RAW, 1).toString("base64"))).ok).toBe(true);
    const overrun = receiver.pushChunk(chunk("o", 1, Buffer.alloc(RAW, 2).toString("base64")));
    expect(overrun.ok).toBe(false);
    if (!overrun.ok) expect(overrun.error.code).toBe("body_overrun");
  });

  it("rejects an over-size final chunk", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    void receiver.begin("os", 40);
    const over = receiver.pushChunk(chunk("os", 0, Buffer.alloc(RAW + 4, 1).toString("base64")));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("chunk_wrong_size");
  });

  it("rejects a chunk that arrives with no matching envelope", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    const orphan = receiver.pushChunk(chunk("missing", 0, Buffer.alloc(RAW, 1).toString("base64")));
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.error.code).toBe("chunk_without_envelope");
  });

  it("rejects a chunk that arrives after completion", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 1024, rawChunkBytes: RAW });
    const promise = receiver.begin("c", RAW);
    expect(receiver.pushChunk(chunk("c", 0, Buffer.alloc(RAW, 1).toString("base64"))).ok).toBe(true);
    await promise;
    const late = receiver.pushChunk(chunk("c", 1, Buffer.alloc(RAW, 2).toString("base64")));
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("chunk_after_completion");
  });
});

describe("duplex body reassembler — spill caps fail closed", () => {
  it("fails closed when a write exceeds the per-channel byte cap and unlinks the partial file", async () => {
    // A 5-byte cap admits the first RAW=8 chunk write? No: reserve 8 > cap 5, so
    // the first write fails closed. Use a cap that admits one chunk but not two.
    const receiver = await makeReceiver({
      spillThresholdBytes: 4,
      rawChunkBytes: RAW,
      channelSpillByteCap: RAW + 2,
    });
    const promise = receiver.begin("cap", 24);
    expect(receiver.pushChunk({ version: DUPLEX_FRAME_VERSION, type: "body_chunk", id: "cap", seq: 0, data: Buffer.alloc(RAW, 1).toString("base64") }).ok).toBe(true);
    // The second chunk write reserves past the byte cap.
    receiver.pushChunk({ version: DUPLEX_FRAME_VERSION, type: "body_chunk", id: "cap", seq: 1, data: Buffer.alloc(RAW, 2).toString("base64") });
    await expect(promise).rejects.toMatchObject({ code: "spill_cap_exceeded" });
    // The partial file is gone and the reservation released.
    expect(receiver.spillUsedBytes).toBe(0);
    expect(receiver.spillOpenFiles).toBe(0);
    const entries = await fs.readdir(receiver.spillDir);
    expect(entries).toHaveLength(0);
    await receiver.destroy();
  });

  it("fails closed when the open-file cap is reached", async () => {
    const receiver = await makeReceiver({
      spillThresholdBytes: 4,
      rawChunkBytes: RAW,
      channelSpillFileCap: 1,
    });
    // The first spill body claims the one file slot and stays open. The channel
    // dispose rejects this in-flight body, so attach the catch at once.
    const first = receiver.begin("f1", 24);
    first.catch(() => undefined);
    expect(receiver.pushChunk({ version: DUPLEX_FRAME_VERSION, type: "body_chunk", id: "f1", seq: 0, data: Buffer.alloc(RAW, 1).toString("base64") }).ok).toBe(true);
    // The second spill body cannot claim a file slot.
    await expect(receiver.begin("f2", 24)).rejects.toMatchObject({ code: "spill_cap_exceeded" });
    expect(receiver.spillOpenFiles).toBe(1);
    // The dispose of the in-flight first body rejects its begin promise with a
    // terminal channel-closed error and frees the file slot.
    await receiver.disposeBody("f1");
    await expect(first).rejects.toMatchObject({ code: "channel_closed" });
    expect(receiver.spillOpenFiles).toBe(0);
    await receiver.destroy();
  });
});

describe("duplex body reassembler — lifecycle cleanup", () => {
  it("releases the reservation and unlinks the file on channel death", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 4, rawChunkBytes: RAW });
    // The channel death rejects this in-flight body, so attach the catch at once.
    const dying = receiver.begin("death", 24);
    dying.catch(() => undefined);
    expect(receiver.pushChunk({ version: DUPLEX_FRAME_VERSION, type: "body_chunk", id: "death", seq: 0, data: Buffer.alloc(RAW, 1).toString("base64") }).ok).toBe(true);
    // Wait for the write to land, so the file exists before the channel dies.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(receiver.spillOpenFiles).toBe(1);
    await receiver.disposeAll();
    await expect(dying).rejects.toMatchObject({ code: "channel_closed" });
    expect(receiver.spillUsedBytes).toBe(0);
    expect(receiver.spillOpenFiles).toBe(0);
    const entries = await fs.readdir(receiver.spillDir);
    expect(entries).toHaveLength(0);
    await receiver.destroy();
  });
});

describe("duplex body reassembler — spill file safety", () => {
  it("creates the spill directory with mode 0700 and each spill file with mode 0600", async () => {
    const receiver = await makeReceiver({ spillThresholdBytes: 4, rawChunkBytes: RAW });
    const dirStat = await fs.stat(receiver.spillDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
    // The final destroy rejects this in-flight body, so attach the catch at once.
    const pending = receiver.begin("mode", 8);
    pending.catch(() => undefined);
    receiver.pushChunk({ version: DUPLEX_FRAME_VERSION, type: "body_chunk", id: "mode", seq: 0, data: Buffer.alloc(RAW, 1).toString("base64") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entries = await fs.readdir(receiver.spillDir);
    expect(entries).toHaveLength(1);
    // The file name is random, so no frame id rides the path.
    expect(entries[0]).not.toContain("mode");
    const fileStat = await fs.stat(path.join(receiver.spillDir, entries[0]));
    expect(fileStat.mode & 0o777).toBe(0o600);
    await receiver.destroy();
  });
});

describe("duplex body reassembler — startup sweep", () => {
  it("removes a stale spill directory from a dead process but keeps a live one", async () => {
    const deadPid = 999999; // A pid that is almost never alive.
    const staleDir = path.join(spillRoot, `paperclip-duplex-spill-${deadPid}-stale`);
    await fs.mkdir(staleDir);
    await fs.writeFile(path.join(staleDir, "leftover.body"), "x");
    const liveDir = path.join(spillRoot, `paperclip-duplex-spill-${process.pid}-live`);
    await fs.mkdir(liveDir);
    await sweepStaleSpillDirectories(spillRoot);
    await expect(fs.stat(staleDir)).rejects.toThrow();
    // The sweep keeps a directory that belongs to a live process.
    await expect(fs.stat(liveDir)).resolves.toBeDefined();
  });
});
