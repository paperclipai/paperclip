import type { RawLidarPoint } from "./types.js";

// ---------------------------------------------------------------------------
// LAS 1.2 / 1.3 binary parser
// ---------------------------------------------------------------------------
// LAS file structure (spec ASPRS LAS 1.2 / 1.3):
//   - Public Header Block (227 bytes for 1.2, 375 bytes for 1.4)
//   - Variable-Length Records
//   - Point Data Records
//
// Only Point Data Format 0, 1, and 6 are handled here (most common formats).

const LAS_FILE_SIGNATURE = 0x4c415346; // "LASF" as big-endian uint32

// GPS adjusted standard time = GPS standard time - 1e9.
// GPS epoch is Jan 6, 1980 = Unix epoch + 315,964,800 s.
const GPS_ADJUSTED_BIAS = 1_000_000_000;
const GPS_TO_UNIX_OFFSET = 315_964_800; // seconds

interface LasHeader {
  versionMajor: number;
  versionMinor: number;
  /** LAS 1.2+ global encoding word (bit 0 = GPS time type). */
  globalEncoding: number;
  headerSize: number;
  offsetToPointData: number;
  pointDataFormatId: number;
  pointDataRecordLength: number;
  numberOfPointRecords: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export class LasParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LasParseError";
  }
}

function readHeader(buf: Buffer): LasHeader {
  if (buf.length < 227) {
    throw new LasParseError("Buffer too small to contain a valid LAS header");
  }

  const sig = buf.readUInt32BE(0);
  if (sig !== LAS_FILE_SIGNATURE) {
    throw new LasParseError(
      `Invalid LAS file signature: expected LASF, got 0x${sig.toString(16)}`,
    );
  }

  const versionMajor = buf.readUInt8(24);
  const versionMinor = buf.readUInt8(25);

  if (versionMajor !== 1 || ![0, 1, 2, 3, 4].includes(versionMinor)) {
    throw new LasParseError(
      `Unsupported LAS version ${versionMajor}.${versionMinor}`,
    );
  }

  // Global encoding was introduced in LAS 1.2; default to 0 for earlier versions.
  const globalEncoding =
    versionMinor >= 2 ? buf.readUInt16LE(6) : 0;

  const headerSize = buf.readUInt16LE(94);
  const offsetToPointData = buf.readUInt32LE(96);
  const pointDataFormatId = buf.readUInt8(104);
  const pointDataRecordLength = buf.readUInt16LE(105);

  // LAS 1.4 uses 64-bit record counts; we only read the legacy 32-bit field here.
  const numberOfPointRecords = buf.readUInt32LE(107);

  const scaleX = buf.readDoubleLE(131);
  const scaleY = buf.readDoubleLE(139);
  const scaleZ = buf.readDoubleLE(147);
  const offsetX = buf.readDoubleLE(155);
  const offsetY = buf.readDoubleLE(163);
  const offsetZ = buf.readDoubleLE(171);

  return {
    versionMajor,
    versionMinor,
    globalEncoding,
    headerSize,
    offsetToPointData,
    pointDataFormatId,
    pointDataRecordLength,
    numberOfPointRecords,
    scaleX,
    scaleY,
    scaleZ,
    offsetX,
    offsetY,
    offsetZ,
  };
}

/**
 * Parse a LAS 1.2/1.3 buffer (point formats 0, 1, 6) into raw point records.
 *
 * LAZ files must be decompressed before calling this function — this parser
 * handles the uncompressed LAS byte stream only.
 */
export function parseLas(buf: Buffer, timestampMs: number): RawLidarPoint[] {
  const hdr = readHeader(buf);

  if (![0, 1, 6].includes(hdr.pointDataFormatId)) {
    throw new LasParseError(
      `Point Data Format ${hdr.pointDataFormatId} is not supported (supported: 0, 1, 6)`,
    );
  }

  const count = hdr.numberOfPointRecords;
  const stride = hdr.pointDataRecordLength;
  const base = hdr.offsetToPointData;

  if (buf.length < base + count * stride) {
    throw new LasParseError(
      `Buffer length ${buf.length} is shorter than expected ` +
        `${base + count * stride} bytes for ${count} point records`,
    );
  }

  const points: RawLidarPoint[] = [];

  for (let i = 0; i < count; i++) {
    const offset = base + i * stride;

    const rawX = buf.readInt32LE(offset);
    const rawY = buf.readInt32LE(offset + 4);
    const rawZ = buf.readInt32LE(offset + 8);

    const x = rawX * hdr.scaleX + hdr.offsetX;
    const y = rawY * hdr.scaleY + hdr.offsetY;
    const z = rawZ * hdr.scaleZ + hdr.offsetZ;

    const intensity = buf.readUInt16LE(offset + 12);

    const returnByte = buf.readUInt8(offset + 14);
    let returnNumber: number;
    let numberOfReturns: number;
    let classification: number;
    let ts = timestampMs;

    if (hdr.pointDataFormatId === 6) {
      // LAS 1.4 format 6: 4-bit return fields, classification at byte 16, GPS time at byte 22.
      // Bit 0 of globalEncoding=1 → GPS adjusted standard time.
      returnNumber = returnByte & 0x0f;
      numberOfReturns = (returnByte >> 4) & 0x0f;
      classification = buf.readUInt8(offset + 16);
      if (stride >= 30) {
        const gpsRaw = buf.readDoubleLE(offset + 22);
        if (hdr.globalEncoding & 0x01) {
          ts = (gpsRaw + GPS_ADJUSTED_BIAS + GPS_TO_UNIX_OFFSET) * 1000;
        }
      }
    } else {
      // Formats 0 and 1: 3-bit return fields, classification at byte 15.
      // Format 1 carries a GPS time at bytes 20-27 (LE double).
      // Bit 0=0 → GPS week time, which we cannot reliably convert without the week
      // number, so fall back to the event receive time.
      returnNumber = returnByte & 0x07;
      numberOfReturns = (returnByte >> 3) & 0x07;
      classification = buf.readUInt8(offset + 15);
      if (hdr.pointDataFormatId === 1 && stride >= 28) {
        const gpsRaw = buf.readDoubleLE(offset + 20);
        if (hdr.globalEncoding & 0x01) {
          ts = (gpsRaw + GPS_ADJUSTED_BIAS + GPS_TO_UNIX_OFFSET) * 1000;
        }
      }
    }

    points.push({
      x,
      y,
      z,
      intensity,
      classification,
      timestamp: ts,
      returnNumber,
      numberOfReturns,
    });
  }

  return points;
}

/**
 * Build a minimal valid LAS buffer for testing.
 *
 * Supports formats 0, 1 (LAS 1.2) and 6 (LAS 1.4).
 * @param globalEncoding Written to bytes 6-7. Set bit 0 to use GPS adjusted standard time.
 * @param gpsTimesPerPoint Per-point GPS time values (used for formats 1 and 6).
 */
export function buildSyntheticLasBuffer(
  points: Array<{ x: number; y: number; z: number; intensity?: number; classification?: number }>,
  opts: {
    scaleX?: number;
    scaleY?: number;
    scaleZ?: number;
    offsetX?: number;
    offsetY?: number;
    offsetZ?: number;
    format?: 0 | 1 | 6;
    globalEncoding?: number;
    gpsTimesPerPoint?: number[];
  } = {},
): Buffer {
  const scaleX = opts.scaleX ?? 0.01;
  const scaleY = opts.scaleY ?? 0.01;
  const scaleZ = opts.scaleZ ?? 0.01;
  const offsetX = opts.offsetX ?? 0;
  const offsetY = opts.offsetY ?? 0;
  const offsetZ = opts.offsetZ ?? 0;
  const format = opts.format ?? 0;
  const globalEncoding = opts.globalEncoding ?? 0;

  const HEADER_SIZE = 227;
  // Format 0: 20 bytes/point; Format 1: 28 bytes/point; Format 6 (LAS 1.4): 30 bytes/point
  const POINT_STRIDE = format === 1 ? 28 : format === 6 ? 30 : 20;
  const totalSize = HEADER_SIZE + points.length * POINT_STRIDE;
  const buf = Buffer.alloc(totalSize, 0);

  // Signature "LASF"
  buf.writeUInt32BE(LAS_FILE_SIGNATURE, 0);

  // Global encoding (LAS 1.2+)
  buf.writeUInt16LE(globalEncoding, 6);

  // Version: 1.4 for format 6, 1.2 for formats 0/1
  buf.writeUInt8(1, 24);
  buf.writeUInt8(format === 6 ? 4 : 2, 25);

  // Header size
  buf.writeUInt16LE(HEADER_SIZE, 94);
  // Offset to point data
  buf.writeUInt32LE(HEADER_SIZE, 96);
  // Point data format and stride
  buf.writeUInt8(format, 104);
  buf.writeUInt16LE(POINT_STRIDE, 105);
  // Number of point records
  buf.writeUInt32LE(points.length, 107);

  // Scale factors (doubles)
  buf.writeDoubleLE(scaleX, 131);
  buf.writeDoubleLE(scaleY, 139);
  buf.writeDoubleLE(scaleZ, 147);
  buf.writeDoubleLE(offsetX, 155);
  buf.writeDoubleLE(offsetY, 163);
  buf.writeDoubleLE(offsetZ, 171);

  // Point records
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const base = HEADER_SIZE + i * POINT_STRIDE;
    buf.writeInt32LE(Math.round((p.x - offsetX) / scaleX), base);
    buf.writeInt32LE(Math.round((p.y - offsetY) / scaleY), base + 4);
    buf.writeInt32LE(Math.round((p.z - offsetZ) / scaleZ), base + 8);
    buf.writeUInt16LE(p.intensity ?? 1000, base + 12);
    if (format === 6) {
      // LAS 1.4 format 6: 4-bit return fields at byte 14, classification at byte 16, GPS time at byte 22
      buf.writeUInt8(0x11, base + 14); // return 1 of 1 (4-bit fields: 0x01 | (0x01 << 4))
      buf.writeUInt8(p.classification ?? 1, base + 16);
      buf.writeDoubleLE(opts.gpsTimesPerPoint?.[i] ?? 0, base + 22);
    } else {
      buf.writeUInt8(0x11, base + 14); // return 1 of 1
      buf.writeUInt8(p.classification ?? 1, base + 15);
      if (format === 1) {
        buf.writeDoubleLE(opts.gpsTimesPerPoint?.[i] ?? 0, base + 20);
      }
    }
  }

  return buf;
}
