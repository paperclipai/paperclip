import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DUPLEX_FRAME_BYTES,
  DUPLEX_FRAME_VERSION,
  decodeDuplexLine,
  encodeDuplexFrame,
  encodeDuplexFrameChecked,
  type DuplexFrame,
} from "./duplex-frame-codec.js";

// One expected decode result in the fixture: either a decoded frame or the code
// of a protocol error. The codec must never throw on the read path.
type ExpectedResult = { frame: DuplexFrame } | { error: string };

interface Vector {
  name: string;
  category: "valid" | "invalid" | "versionMismatch";
  bytes: string;
  roundTrip?: boolean;
  expected: ExpectedResult[];
}

// One encode-bound vector: a frame, the size limit, and the expected checked
// encode result. An ok result must also decode back to the same frame.
interface EncodeVector {
  name: string;
  maxFrameBytes: number;
  frame: DuplexFrame;
  expected: { ok: true } | { ok: false; error: string };
}

interface Fixture {
  frameVersion: number;
  defaultMaxFrameBytes: number;
  vectors: Vector[];
  encodeVectors: EncodeVector[];
}

const fixturePath = fileURLToPath(
  new URL("./duplex-frame-vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("duplex frame codec fixture", () => {
  it("the fixture version matches the codec version", () => {
    expect(fixture.frameVersion).toBe(DUPLEX_FRAME_VERSION);
    expect(fixture.defaultMaxFrameBytes).toBe(DEFAULT_MAX_DUPLEX_FRAME_BYTES);
  });

  it("every category has at least one vector", () => {
    const categories = new Set(fixture.vectors.map((vector) => vector.category));
    for (const category of ["valid", "invalid", "versionMismatch"]) {
      expect(categories).toContain(category);
    }
  });

  for (const vector of fixture.vectors) {
    it(`decodes the ${vector.name} vector`, () => {
      // Every remaining vector is one complete line, so `decodeDuplexLine`
      // reads it directly. The trailing newline in the fixture bytes is not
      // part of the line the decoder reads.
      const line = vector.bytes.endsWith("\n") ? vector.bytes.slice(0, -1) : vector.bytes;
      const result = decodeDuplexLine(line);
      const want = vector.expected[0];
      if ("frame" in want) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.frame).toEqual(want.frame);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe(want.error);
      }
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
    for (const type of ["ready", "heartbeat", "close", "error"]) {
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

describe("size-checked encode", () => {
  it("runs every shared encode vector and matches the expected result", () => {
    // Every codec copy runs the same encode vectors. This copy proves it enforces
    // the same bound the embedded gateway copy enforces.
    for (const vector of fixture.encodeVectors) {
      const result = encodeDuplexFrameChecked(vector.frame, vector.maxFrameBytes);
      expect(result.ok).toBe(vector.expected.ok);
      if (result.ok) {
        // An ok line ends with one newline and decodes back to the same frame, so
        // the encode guard never truncates or passes a bad frame through.
        expect(result.line.endsWith("\n")).toBe(true);
        expect(result.line.slice(0, -1)).not.toContain("\n");
        const decoded = decodeDuplexLine(result.line.slice(0, -1));
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect(decoded.frame).toEqual(vector.frame);
      } else if (!vector.expected.ok) {
        expect(result.error.code).toBe(vector.expected.error);
      }
    }
  });

  it("rejects an over-bound frame with a typed outcome and never throws", () => {
    const frame: DuplexFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "error",
      code: "read_timeout",
      message: "x".repeat(2_000),
    };
    expect(() => encodeDuplexFrameChecked(frame, 1_000)).not.toThrow();
    const result = encodeDuplexFrameChecked(frame, 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("frame_too_large");
  });

  it("measures the bound in bytes without the trailing newline, so the boundary is inclusive", () => {
    // Build a frame whose encoded JSON is exactly N bytes. The guard measures the
    // JSON without the newline, so N bytes encodes and N+1 bytes fails. This is the
    // same boundary the decoder applies, so encode and decode agree exactly.
    // Pad the message to grow the encoded JSON by an exact byte count. Each
    // padding character adds one byte, so the frame lands on an exact size the
    // guard measures without the trailing newline.
    const pad = (n: number): DuplexFrame => ({
      version: DUPLEX_FRAME_VERSION,
      type: "error",
      code: "boundary",
      message: "x".repeat(n),
    });
    const baseBytes = Buffer.byteLength(JSON.stringify(pad(0)), "utf8");
    const limit = baseBytes + 10;
    const atLimit = pad(10);
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(limit);
    const okResult = encodeDuplexFrameChecked(atLimit, limit);
    expect(okResult.ok).toBe(true);
    const overResult = encodeDuplexFrameChecked(pad(11), limit);
    expect(overResult.ok).toBe(false);
    if (!overResult.ok) expect(overResult.error.code).toBe("frame_too_large");
  });

  it("defaults the bound to the default max frame bytes", () => {
    const frame: DuplexFrame = { version: DUPLEX_FRAME_VERSION, type: "heartbeat" };
    const result = encodeDuplexFrameChecked(frame);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.line).toBe(encodeDuplexFrame(frame));
  });
});
