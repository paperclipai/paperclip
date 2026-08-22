import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DUPLEX_FRAME_BYTES,
  DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES,
  DUPLEX_FRAME_VERSION,
  DuplexFrameDecoder,
  decodeDuplexLine,
  encodeDuplexFrame,
  type DuplexDecodeResult,
  type DuplexFrame,
} from "./duplex-frame-codec.js";

// One expected decode result in the fixture: either a decoded frame or the code
// of a protocol error. The codec must never throw on the read path.
type ExpectedResult = { frame: DuplexFrame } | { error: string };

interface Vector {
  name: string;
  category:
    | "valid"
    | "invalid"
    | "partial"
    | "oversized"
    | "versionMismatch"
    | "idBoundValid"
    | "idBoundInvalid";
  bytes: string;
  splitByteOffsets?: number[];
  maxFrameBytes?: number;
  roundTrip?: boolean;
  expected: ExpectedResult[];
}

interface Fixture {
  frameVersion: number;
  defaultMaxFrameBytes: number;
  vectors: Vector[];
}

const fixturePath = fileURLToPath(
  new URL("./duplex-frame-vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

// Cut one UTF-8 byte stream into chunks at the byte offsets. The decoder must
// keep partial bytes between chunks, so the split can fall inside a multi-byte
// character.
function toChunks(bytes: string, offsets: number[] | undefined): Buffer[] {
  const buffer = Buffer.from(bytes, "utf8");
  if (!offsets || offsets.length === 0) return [buffer];
  const bounds = [0, ...offsets, buffer.length];
  const chunks: Buffer[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    chunks.push(buffer.subarray(bounds[i], bounds[i + 1]));
  }
  return chunks;
}

function pushAll(decoder: DuplexFrameDecoder, chunks: Buffer[]): DuplexDecodeResult[] {
  const results: DuplexDecodeResult[] = [];
  for (const chunk of chunks) results.push(...decoder.push(chunk));
  return results;
}

function assertMatches(results: DuplexDecodeResult[], expected: ExpectedResult[]): void {
  expect(results).toHaveLength(expected.length);
  results.forEach((result, index) => {
    const want = expected[index];
    if ("frame" in want) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.frame).toEqual(want.frame);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(want.error);
    }
  });
}

describe("duplex frame codec fixture", () => {
  it("the fixture version matches the codec version", () => {
    expect(fixture.frameVersion).toBe(DUPLEX_FRAME_VERSION);
    expect(fixture.defaultMaxFrameBytes).toBe(DEFAULT_MAX_DUPLEX_FRAME_BYTES);
  });

  it("every category has at least one vector", () => {
    const categories = new Set(fixture.vectors.map((vector) => vector.category));
    for (const category of ["valid", "invalid", "partial", "oversized", "versionMismatch"]) {
      expect(categories).toContain(category);
    }
  });

  for (const vector of fixture.vectors) {
    it(`decodes the ${vector.name} vector`, () => {
      const decoder = new DuplexFrameDecoder(
        vector.maxFrameBytes ? { maxFrameBytes: vector.maxFrameBytes } : undefined,
      );
      const chunks = toChunks(vector.bytes, vector.splitByteOffsets);
      const results = pushAll(decoder, chunks);
      assertMatches(results, vector.expected);
    });
  }
});

describe("round-trip", () => {
  const validVectors = fixture.vectors.filter((vector) => vector.roundTrip);

  it("has round-trip vectors for every frame type", () => {
    const types = new Set(
      validVectors.flatMap((vector) =>
        vector.expected.flatMap((result) =>
          "frame" in result ? [result.frame.type] : [],
        ),
      ),
    );
    for (const type of ["request", "response", "ready", "heartbeat", "close", "error"]) {
      expect(types).toContain(type);
    }
  });

  for (const vector of validVectors) {
    it(`re-encodes the ${vector.name} frame to the same value`, () => {
      const want = vector.expected[0];
      expect("frame" in want).toBe(true);
      if (!("frame" in want)) return;
      const encoded = encodeDuplexFrame(want.frame);
      // Encode writes exactly one line: it ends with one newline and holds no
      // interior newline, so one frame stays on one line.
      expect(encoded.endsWith("\n")).toBe(true);
      expect(encoded.slice(0, -1)).not.toContain("\n");
      const decoded = decodeDuplexLine(encoded.slice(0, -1));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.frame).toEqual(want.frame);
    });
  }
});

describe("ready frame schema", () => {
  // READY is a liveness signal, not an address source. The strict schema holds
  // exactly the frame version and the nonce.
  it("accepts a READY frame that carries exactly the version and the nonce", () => {
    const result = decodeDuplexLine(
      JSON.stringify({ version: DUPLEX_FRAME_VERSION, type: "ready", nonce: "a1b2c3d4e5f6a7b8" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame).toEqual({
        version: DUPLEX_FRAME_VERSION,
        type: "ready",
        nonce: "a1b2c3d4e5f6a7b8",
      });
    }
  });

  it.each([
    { name: "an absent nonce", frame: { version: DUPLEX_FRAME_VERSION, type: "ready" } },
    {
      name: "a wrong-typed nonce",
      frame: { version: DUPLEX_FRAME_VERSION, type: "ready", nonce: 42 },
    },
    {
      name: "an extra address field",
      frame: {
        version: DUPLEX_FRAME_VERSION,
        type: "ready",
        nonce: "a1b2c3d4e5f6a7b8",
        address: "http://127.0.0.1:47215",
      },
    },
    {
      name: "an extra port field",
      frame: { version: DUPLEX_FRAME_VERSION, type: "ready", nonce: "a1b2c3d4e5f6a7b8", port: 47215 },
    },
  ])("rejects a READY frame with $name", ({ frame }) => {
    const result = decodeDuplexLine(JSON.stringify(frame));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_frame");
  });
});

describe("streaming decoder behavior", () => {
  it("emits nothing until a full line arrives, then the complete frame", () => {
    const decoder = new DuplexFrameDecoder();
    const line = encodeDuplexFrame({ version: DUPLEX_FRAME_VERSION, type: "heartbeat" });
    const bytes = Buffer.from(line, "utf8");
    const first = decoder.push(bytes.subarray(0, 3));
    expect(first).toHaveLength(0);
    const second = decoder.push(bytes.subarray(3));
    expect(second).toHaveLength(1);
    expect(second[0].ok).toBe(true);
  });

  it("keeps a multi-byte UTF-8 sequence valid across a chunk boundary", () => {
    const decoder = new DuplexFrameDecoder();
    const frame: DuplexFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "request",
      id: "req-emoji",
      method: "POST",
      path: "/x",
      query: "",
      headers: {},
      body: "😀",
    };
    const bytes = Buffer.from(encodeDuplexFrame(frame), "utf8");
    // Split inside the four-byte emoji, right before a continuation byte.
    let cut = -1;
    for (let i = 1; i < bytes.length; i += 1) {
      if ((bytes[i] & 0xc0) === 0x80) {
        cut = i;
        break;
      }
    }
    expect(cut).toBeGreaterThan(0);
    const results = [
      ...decoder.push(bytes.subarray(0, cut)),
      ...decoder.push(bytes.subarray(cut)),
    ];
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    if (results[0].ok) expect(results[0].frame).toEqual(frame);
  });

  it("rejects an oversized frame with a protocol error, then resynchronizes", () => {
    const decoder = new DuplexFrameDecoder({ maxFrameBytes: 32 });
    const flood = `${"z".repeat(100)}\n`;
    const good = encodeDuplexFrame({ version: DUPLEX_FRAME_VERSION, type: "heartbeat" });
    const results = decoder.push(Buffer.from(flood + good, "utf8"));
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(false);
    if (!results[0].ok) expect(results[0].error.code).toBe("frame_too_large");
    expect(results[1].ok).toBe(true);
  });

  it("rejects a version-mismatch frame with a protocol error", () => {
    const decoder = new DuplexFrameDecoder();
    const results = decoder.push(
      Buffer.from(`${JSON.stringify({ version: 999, type: "heartbeat" })}\n`, "utf8"),
    );
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    if (!results[0].ok) expect(results[0].error.code).toBe("version_mismatch");
  });

  it("never throws on a malformed read; it returns a protocol error", () => {
    const decoder = new DuplexFrameDecoder();
    expect(() => decoder.push(Buffer.from("this is not json\n", "utf8"))).not.toThrow();
    const results = decoder.push(Buffer.from("still not json\n", "utf8"));
    expect(results[0].ok).toBe(false);
  });
});

describe("request id byte bound", () => {
  // The id byte bound caps the memory the host broker retains per distinct
  // request. The bound is 256 bytes; a UTF-8 id byte can differ from a character.
  function requestWithId(id: string): string {
    return JSON.stringify({
      version: DUPLEX_FRAME_VERSION,
      type: "request",
      id,
      method: "GET",
      path: "/",
      query: "",
      headers: {},
      body: "",
    });
  }

  it("accepts an id at the maximum byte size", () => {
    const id = "a".repeat(DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES);
    const result = decodeDuplexLine(requestWithId(id));
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === "request") expect(result.frame.id).toBe(id);
  });

  it("rejects an over-limit id with an id_too_large protocol error and never throws", () => {
    const id = "a".repeat(DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES + 1);
    expect(() => decodeDuplexLine(requestWithId(id))).not.toThrow();
    const result = decodeDuplexLine(requestWithId(id));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("id_too_large");
  });

  it("measures the id in bytes, not characters, so a multi-byte id over the byte bound is rejected", () => {
    // Each "😀" is four UTF-8 bytes. 65 code points make 260 bytes, one code point
    // makes 4 bytes, so 65 stays over the 256-byte bound while the character count
    // stays under it.
    const id = "😀".repeat(65);
    expect(id.length).toBeLessThan(DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES);
    const result = decodeDuplexLine(requestWithId(id));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("id_too_large");
  });

  it("applies the same bound to the response id", () => {
    const id = "b".repeat(DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES + 1);
    const result = decodeDuplexLine(
      JSON.stringify({
        version: DUPLEX_FRAME_VERSION,
        type: "response",
        id,
        status: 200,
        headers: {},
        body: "",
        outcome: "completed",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("id_too_large");
  });
});
