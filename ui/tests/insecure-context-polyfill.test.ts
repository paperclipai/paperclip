import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

type UuidApi = { randomUUID: () => string };

function polyfillSource(): string {
  const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
  const block = blocks.find((source) => source.includes("randomUUID"));
  if (!block) throw new Error("polyfill script not found in ui/index.html");
  return block;
}

function fakeInsecureCrypto(round: { n: number }): { getRandomValues: <T extends ArrayBufferView>(array: T) => T } {
  return {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      round.n += 1;
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (index * 31 + round.n * 17 + 7) & 0xff;
      }
      return array;
    },
  };
}

const V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("crypto.randomUUID insecure-context polyfill", () => {
  it("installs a v4 UUID generator when the native API is missing", () => {
    const sandbox: { crypto: unknown } = { crypto: fakeInsecureCrypto({ n: 0 }) };
    vm.runInNewContext(polyfillSource(), sandbox);
    const uuid = (sandbox.crypto as unknown as UuidApi).randomUUID();
    expect(uuid).toMatch(V4_PATTERN);
  });

  it("generates distinct UUIDs across calls", () => {
    const sandbox: { crypto: unknown } = { crypto: fakeInsecureCrypto({ n: 0 }) };
    vm.runInNewContext(polyfillSource(), sandbox);
    const api = sandbox.crypto as unknown as UuidApi;
    expect(api.randomUUID()).not.toBe(api.randomUUID());
  });

  it("keeps the native API when it exists", () => {
    const nativeRandomUUID = () => "native";
    const sandbox: { crypto: unknown } = {
      crypto: { getRandomValues: fakeInsecureCrypto({ n: 0 }).getRandomValues, randomUUID: nativeRandomUUID },
    };
    vm.runInNewContext(polyfillSource(), sandbox);
    expect((sandbox.crypto as unknown as UuidApi).randomUUID).toBe(nativeRandomUUID);
  });

  it("does not throw when crypto is absent", () => {
    expect(() => vm.runInNewContext(polyfillSource(), {})).not.toThrow();
  });
});
