/**
 * Round-trip tests for the sessionCodec exported from src/server/index.ts.
 *
 * Paperclip stores `sessionParams` as opaque JSON; the codec validates the
 * shape on read and ensures the round-trip is lossless for the canonical
 * field set.
 */

import { describe, expect, it } from "vitest";
import { sessionCodec } from "../server/index.js";

describe("sessionCodec.deserialize", () => {
  it("requires sessionId", () => {
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.deserialize({ cwd: "/x" })).toBeNull();
  });

  it("returns null for non-object inputs", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("string")).toBeNull();
    expect(sessionCodec.deserialize([1, 2, 3])).toBeNull();
  });

  it("extracts the canonical field set", () => {
    const result = sessionCodec.deserialize({
      sessionId: "amp-sess-123",
      cwd: "/Users/me/proj",
      workspaceId: "ws-99",
      repoUrl: "git@github.com:me/proj.git",
      repoRef: "main",
    });
    expect(result).toEqual({
      sessionId: "amp-sess-123",
      cwd: "/Users/me/proj",
      workspaceId: "ws-99",
      repoUrl: "git@github.com:me/proj.git",
      repoRef: "main",
    });
  });

  it("accepts snake_case aliases (forward-compat)", () => {
    const result = sessionCodec.deserialize({
      session_id: "amp-sess-123",
      workdir: "/Users/me/proj",
      workspace_id: "ws-99",
      repo_url: "git@github.com:me/proj.git",
      repo_ref: "main",
    });
    expect(result).toEqual({
      sessionId: "amp-sess-123",
      cwd: "/Users/me/proj",
      workspaceId: "ws-99",
      repoUrl: "git@github.com:me/proj.git",
      repoRef: "main",
    });
  });

  it("omits empty optional fields rather than persisting empty strings", () => {
    const result = sessionCodec.deserialize({
      sessionId: "amp-sess-123",
      cwd: "",
      workspaceId: "",
    });
    expect(result).toEqual({ sessionId: "amp-sess-123" });
  });
});

describe("sessionCodec.serialize", () => {
  it("returns null when input is null or has no sessionId", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
    expect(sessionCodec.serialize({})).toBeNull();
  });

  it("round-trips with deserialize", () => {
    const original = {
      sessionId: "amp-sess-rt",
      cwd: "/proj",
      workspaceId: "ws-1",
    };
    const serialized = sessionCodec.serialize(original);
    const deserialized = sessionCodec.deserialize(serialized);
    expect(deserialized).toEqual(original);
  });
});

describe("sessionCodec.getDisplayId", () => {
  it("returns the sessionId", () => {
    expect(sessionCodec.getDisplayId!({ sessionId: "amp-sess-display" })).toBe(
      "amp-sess-display",
    );
  });

  it("returns null for null input", () => {
    expect(sessionCodec.getDisplayId!(null)).toBeNull();
  });
});
