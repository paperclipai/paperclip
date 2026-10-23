// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

import { buildImportTransferManifest } from "./import-transfer";

describe("buildImportTransferManifest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hashes the whole buffer and every byte-range part in a secure context", async () => {
    // Node 20 exposes webcrypto; the real path reads it as `globalThis.crypto`.
    vi.stubGlobal("crypto", webcrypto);
    const buffer = new Uint8Array([0, 1, 2, 3, 4]).buffer;
    const manifest = await buildImportTransferManifest(buffer);
    expect(manifest.totalBytes).toBe(5);
    expect(manifest.parts).toHaveLength(1);
    expect(manifest.zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.parts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects with a HTTPS/localhost hint when SubtleCrypto is unavailable", async () => {
    // Simulate the http:// (non-localhost) deployment where crypto.subtle is undefined.
    vi.stubGlobal("crypto", { subtle: undefined });
    await expect(buildImportTransferManifest(new ArrayBuffer(1))).rejects.toThrow(
      /HTTPS or http:\/\/localhost/,
    );
  });
});
