import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PluginStateClient } from "@paperclipai/plugin-sdk";
import { ensureStubWebhookSecret, headerValue, signStubPayload, verifyStubSignature } from "../src/hmac.js";

describe("stub HMAC", () => {
  it("signs with HMAC-SHA256 hex over the exact raw body", () => {
    const expected = createHmac("sha256", "s3cret").update("{\"a\":1}").digest("hex");
    expect(signStubPayload("s3cret", "{\"a\":1}")).toBe(expected);
  });

  it("verifies a valid signature and rejects tampered body, wrong secret, missing or malformed signature", () => {
    const body = JSON.stringify({ type: "payment.succeeded", subRef: "psub-1" });
    const sig = signStubPayload("s3cret", body);
    expect(verifyStubSignature("s3cret", body, sig)).toBe(true);
    expect(verifyStubSignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifyStubSignature("other", body, sig)).toBe(false);
    expect(verifyStubSignature("s3cret", body, undefined)).toBe(false);
    expect(verifyStubSignature("s3cret", body, "zz-not-hex")).toBe(false);
    expect(verifyStubSignature("s3cret", body, sig.slice(0, 10))).toBe(false);
  });

  it("headerValue is case-insensitive and unwraps arrays", () => {
    const headers = { "X-Billing-Stub-Signature": ["abc", "def"], other: "x" };
    expect(headerValue(headers, "x-billing-stub-signature")).toBe("abc");
    expect(headerValue(headers, "missing")).toBeUndefined();
  });

  it("rejects a dangling hex nibble appended to a valid signature (odd-length truncation bug)", () => {
    // Buffer.from(str, "hex") silently drops a trailing unpaired nibble instead of
    // erroring, so a 65-char string ending in one extra hex digit used to decode to
    // the same 32 bytes as the genuine 64-char signature and pass verification.
    const body = JSON.stringify({ type: "payment.succeeded", subRef: "psub-1" });
    const sig = signStubPayload("s3cret", body);
    expect(verifyStubSignature("s3cret", body, sig + "f")).toBe(false);
    expect(verifyStubSignature("s3cret", body, sig + "0")).toBe(false);
  });

  it("accepts an uppercase-hex signature (case-insensitive match, canonical length enforced)", () => {
    const body = JSON.stringify({ type: "payment.succeeded", subRef: "psub-1" });
    const sig = signStubPayload("s3cret", body);
    expect(verifyStubSignature("s3cret", body, sig.toUpperCase())).toBe(true);
  });

  it("rejects a truncated 63-char signature", () => {
    const body = JSON.stringify({ type: "payment.succeeded", subRef: "psub-1" });
    const sig = signStubPayload("s3cret", body);
    expect(verifyStubSignature("s3cret", body, sig.slice(0, 63))).toBe(false);
  });
});

describe("ensureStubWebhookSecret", () => {
  function fakeState(): { state: PluginStateClient; values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    const key = (input: { scopeKind: string; stateKey: string }) => `${input.scopeKind}:${input.stateKey}`;
    const state = {
      async get(input: { scopeKind: "instance"; stateKey: string }) { return values.get(key(input)) ?? null; },
      async set(input: { scopeKind: "instance"; stateKey: string }, value: unknown) { values.set(key(input), value); },
      async delete() {},
    } as unknown as PluginStateClient;
    return { state, values };
  }

  it("generates a 64-hex-char secret once and returns the same one afterwards", async () => {
    const { state } = fakeState();
    const first = await ensureStubWebhookSecret(state);
    const second = await ensureStubWebhookSecret(state);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("converges on the stored winner (not the locally minted secret) when a concurrent writer wins the set() race", async () => {
    // ctx.state.set() is a last-write-wins upsert with no compare-and-swap available
    // plugin-side. Simulate a lost race: our set() call is a no-op from storage's
    // perspective because a concurrent writer's secret is what actually lands.
    const values = new Map<string, unknown>();
    const key = (input: { scopeKind: string; stateKey: string }) => `${input.scopeKind}:${input.stateKey}`;
    const winner = "b".repeat(64);
    const state = {
      async get(input: { scopeKind: "instance"; stateKey: string }) { return values.get(key(input)) ?? null; },
      async set(input: { scopeKind: "instance"; stateKey: string }, _value: unknown) {
        values.set(key(input), winner);
      },
      async delete() {},
    } as unknown as PluginStateClient;

    const result = await ensureStubWebhookSecret(state);
    expect(result).toBe(winner);
  });
});
