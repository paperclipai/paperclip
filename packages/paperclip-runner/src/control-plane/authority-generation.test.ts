import { describe, expect, it } from "vitest";
import { authorityDirectlyFollows, authorityGeneration, authorityInteger, validateAuthorityCommit, validateAuthorityWorkPage } from "./durable-authority-store.js";

const first = "r:00000000-0000-4000-8000-000000000001";
const second = "r:00000000-0000-4000-8000-000000000002";
const maximum = "9223372036854775807";

describe("exact authority revisions", () => {
  it("accepts legacy exact boundaries and opaque revisions without converting them to numbers", () => {
    for (const value of ["0", "9007199254740993", maximum, first]) expect(authorityGeneration(value)).toBe(value);
    expect(authorityDirectlyFollows({ generation: first, committedFrom: maximum, state: {} }, maximum)).toBe(true);
    expect(authorityDirectlyFollows({ generation: second, committedFrom: first, state: {} }, first)).toBe(true);
    validateAuthorityCommit({ expectedGeneration: first, state: {}, records: [] });
    validateAuthorityWorkPage("process-owner", "", 128, first);
  });

  it("requires exact immediate predecessor evidence for migration activation", () => {
    const latest = { generation: second, committedFrom: first, state: {} };
    expect(authorityDirectlyFollows(latest, maximum)).toBe(false);
    expect(authorityDirectlyFollows(latest, second)).toBe(false);
    expect(authorityDirectlyFollows({ generation: first, state: {} }, maximum)).toBe(false);
    expect(authorityDirectlyFollows({ generation: "2", state: {} }, first)).toBe(false);
    expect(authorityDirectlyFollows({ generation: first, committedFrom: first, state: {} }, first)).toBe(false);
    expect(authorityDirectlyFollows({ generation: "9007199254740993", state: {} }, "9007199254740992")).toBe(true);
    expect(authorityDirectlyFollows({ generation: maximum, state: {} }, maximum)).toBe(false);
  });

  it.each(["-1", "01", "9223372036854775808", "r:missing", first.toUpperCase(), first.replace("-4000-", "-1000-")])("rejects invalid revision %s", value => {
    expect(() => authorityGeneration(value)).toThrow("invalid_authority");
  });

  it("keeps event ordering numeric and separate from opaque state revisions", () => {
    expect(authorityInteger(maximum)).toBe(9_223_372_036_854_775_807n);
    expect(() => authorityInteger(first)).toThrow("invalid_authority");
    expect(() => validateAuthorityCommit({ expectedGeneration: first, state: {}, records: [
      { epoch: "epoch-1", kind: "event", id: "event-1", sequence: second, body: {} },
    ] })).toThrow("invalid_authority");
  });

  it("reserves zero for effects which have exact identities without ordering", () => {
    const receipt = { epoch: "run-1", kind: "effect" as const, id: "effect", sequence: "0", body: {} };
    expect(() => validateAuthorityCommit({ expectedGeneration: first, state: {}, records: [receipt] })).not.toThrow();
    for (const kind of ["command", "event"] as const) {
      expect(() => validateAuthorityCommit({ expectedGeneration: first, state: {}, records: [{ ...receipt, kind }] })).toThrow("invalid_authority");
    }
  });
});
