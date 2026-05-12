import { describe, expect, it } from "vitest";

import {
  appendTargetWithCap,
  BrokerTargetCapExceededError,
  MAX_BROKER_TARGETS_PER_CONNECTION,
  removeTargetById,
  validateBrokerTargetInput,
  type BrokerTarget,
} from "./broker-targets.js";

function fakeTarget(i: number): BrokerTarget {
  return {
    id: `t-${i}`,
    url: `https://b${i}.example.test/push`,
    authTokenSecretId: "00000000-0000-0000-0000-000000000000",
    addedAt: "2026-05-12T00:00:00.000Z",
  };
}

describe("validateBrokerTargetInput", () => {
  it("accepts a valid https URL and uuid secret id", () => {
    const result = validateBrokerTargetInput({
      url: "https://broker.acme.test/push",
      authTokenSecretId: "11111111-2222-3333-4444-555555555555",
    });
    expect(result.url).toBe("https://broker.acme.test/push");
    expect(result.authTokenSecretId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("accepts http for local-dev brokers", () => {
    expect(() =>
      validateBrokerTargetInput({
        url: "http://127.0.0.1:7878/push",
        authTokenSecretId: "11111111-2222-3333-4444-555555555555",
      }),
    ).not.toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() =>
      validateBrokerTargetInput({
        url: "not-a-url",
        authTokenSecretId: "11111111-2222-3333-4444-555555555555",
      }),
    ).toThrow(/invalid broker target/i);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() =>
      validateBrokerTargetInput({
        url: "ftp://broker.acme.test/push",
        authTokenSecretId: "11111111-2222-3333-4444-555555555555",
      }),
    ).toThrow(/http or https/i);
  });

  it("rejects non-uuid secret IDs", () => {
    expect(() =>
      validateBrokerTargetInput({
        url: "https://broker.acme.test/push",
        authTokenSecretId: "not-a-uuid",
      }),
    ).toThrow();
  });
});

describe("appendTargetWithCap", () => {
  it(`returns a new array with the appended target (cap=${MAX_BROKER_TARGETS_PER_CONNECTION})`, () => {
    const current = [fakeTarget(0)];
    const next = appendTargetWithCap(current, fakeTarget(1));
    expect(next).toHaveLength(2);
    expect(next).not.toBe(current); // pure: new array
    expect(next[0]).toEqual(current[0]);
    expect(next[1]).toEqual(fakeTarget(1));
  });

  it(`throws BrokerTargetCapExceededError at exactly ${MAX_BROKER_TARGETS_PER_CONNECTION} existing targets`, () => {
    const full = Array.from(
      { length: MAX_BROKER_TARGETS_PER_CONNECTION },
      (_, i) => fakeTarget(i),
    );
    expect(() => appendTargetWithCap(full, fakeTarget(99))).toThrow(
      BrokerTargetCapExceededError,
    );
  });

  it("BrokerTargetCapExceededError carries the cap value", () => {
    const full = Array.from(
      { length: MAX_BROKER_TARGETS_PER_CONNECTION },
      (_, i) => fakeTarget(i),
    );
    try {
      appendTargetWithCap(full, fakeTarget(99));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerTargetCapExceededError);
      expect((err as BrokerTargetCapExceededError).cap).toBe(
        MAX_BROKER_TARGETS_PER_CONNECTION,
      );
    }
  });
});

describe("removeTargetById", () => {
  it("returns a new array without the matching id", () => {
    const current = [fakeTarget(0), fakeTarget(1), fakeTarget(2)];
    const next = removeTargetById(current, "t-1");
    expect(next).toHaveLength(2);
    expect(next.map((t) => t.id)).toEqual(["t-0", "t-2"]);
  });

  it("is a no-op when the id is absent", () => {
    const current = [fakeTarget(0), fakeTarget(1)];
    const next = removeTargetById(current, "missing");
    expect(next).toEqual(current);
    expect(next).not.toBe(current); // still a new array
  });

  it("returns an empty array unchanged when called on empty input", () => {
    expect(removeTargetById([], "anything")).toEqual([]);
  });
});
