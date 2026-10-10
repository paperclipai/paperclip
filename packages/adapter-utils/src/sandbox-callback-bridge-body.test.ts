import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { decodeSandboxBridgeBody, encodeSandboxBridgeBody, sandboxBridgeBodyCodecSource, sandboxBridgeEnvelopeLimit } from "./sandbox-callback-bridge-body.js";

const embedded = runInNewContext(`${sandboxBridgeBodyCodecSource()}; ({ encodeSandboxBridgeBody, decodeSandboxBridgeBody })`, { Buffer });

describe.each([
  { name: "host", encode: encodeSandboxBridgeBody, decode: decodeSandboxBridgeBody },
  { name: "generated gateway", encode: embedded.encodeSandboxBridgeBody as typeof encodeSandboxBridgeBody, decode: embedded.decodeSandboxBridgeBody as typeof decodeSandboxBridgeBody },
])("queue body codec: $name", ({ encode, decode }) => {
  it("preserves old text envelopes and arbitrary binary bytes at the limit", () => {
    const text = "猫\u0000\n";
    expect(encode(text, 5)).toEqual({ body: text });
    expect(decode({ body: text }, 5)).toEqual(Buffer.from(text));
    expect(decode({ body: text, bodyEncoding: "utf8" }, 5)).toEqual(Buffer.from(text));
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    expect(decode(encode(bytes, bytes.length), bytes.length)).toEqual(bytes);
    expect(encode(bytes, bytes.length).bodyEncoding).toBe("base64");
    expect(() => encode(bytes, bytes.length - 1)).toThrow(/size limit/);
    expect(() => decode(encode(bytes, bytes.length), bytes.length - 1)).toThrow(/size limit/);
    expect(() => decode({ body: text }, 4)).toThrow(/size limit/);
  });

  it.each(["!AAA", "YQ", "YQ=", "YQ===", "YQ==\n", "YR==", "=AAA", "____", "猫"])('rejects malformed or noncanonical base64 "%s"', body => {
    expect(() => decode({ body, bodyEncoding: "base64" }, 1024)).toThrow(/base64/);
  });

  it("rejects unknown encodings and bounds JSON escaping overhead", () => {
    expect(() => decode({ body: "abc", bodyEncoding: "hex" as "utf8" }, 1024)).toThrow(/encoding/);
    expect(() => decode({ body: null as unknown as string }, 1024)).toThrow(/Invalid/);
    const envelope = { id: "request", ...encode("\u0000".repeat(1024), 1024) };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(sandboxBridgeEnvelopeLimit(1024));
  });
});
