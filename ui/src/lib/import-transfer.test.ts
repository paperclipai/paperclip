// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";

import { IMPORT_TRANSFER_PART_SIZE_BYTES, buildImportTransferManifest } from "./import-transfer";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("buildImportTransferManifest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hashes the whole buffer and every byte-range part in a secure context", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const bytes = new Uint8Array(IMPORT_TRANSFER_PART_SIZE_BYTES + 3);
    bytes.fill(1, 0, IMPORT_TRANSFER_PART_SIZE_BYTES);
    bytes.set([2, 3, 4], IMPORT_TRANSFER_PART_SIZE_BYTES);
    const manifest = await buildImportTransferManifest(bytes.buffer);
    expect(manifest.totalBytes).toBe(bytes.byteLength);
    expect(manifest.zipSha256).toBe(sha256Hex(bytes));
    expect(manifest.parts).toEqual([
      {
        index: 0,
        byteSize: IMPORT_TRANSFER_PART_SIZE_BYTES,
        sha256: sha256Hex(bytes.subarray(0, IMPORT_TRANSFER_PART_SIZE_BYTES)),
      },
      {
        index: 1,
        byteSize: 3,
        sha256: sha256Hex(bytes.subarray(IMPORT_TRANSFER_PART_SIZE_BYTES)),
      },
    ]);
  });

  it("rejects with a HTTPS/localhost hint when SubtleCrypto is unavailable", async () => {
    vi.stubGlobal("crypto", { subtle: undefined });
    await expect(buildImportTransferManifest(new ArrayBuffer(1))).rejects.toThrow(
      /HTTPS or http:\/\/localhost/,
    );
  });
});
