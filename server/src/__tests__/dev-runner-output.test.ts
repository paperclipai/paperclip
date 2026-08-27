import { describe, expect, it } from "vitest";
import {
  createCapturedOutputBuffer,
  parseJsonObjectFromCommandOutput,
  parseJsonResponseWithLimit,
} from "../../../scripts/dev-runner-output.mjs";

describe("createCapturedOutputBuffer", () => {
  it("keeps small output unchanged", () => {
    const capture = createCapturedOutputBuffer(32);
    capture.append("hello");
    capture.append(" world");

    expect(capture.finish()).toEqual({
      text: "hello world",
      totalBytes: 11,
      truncated: false,
    });
  });

  it("retains only the bounded tail when output grows large", () => {
    const capture = createCapturedOutputBuffer(8);
    capture.append("abcd");
    capture.append(Buffer.from("efgh"));
    capture.append("ijkl");

    const result = capture.finish();
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(12);
    expect(result.text).toContain("total 12 bytes");
    expect(result.text.endsWith("efghijkl")).toBe(true);
  });

  it("parses a JSON object after prefixed command output", () => {
    const output = [
      '. | WARN Unsupported engine: wanted: {"node":">=24.11.0"}',
      "Scope: 2 of 41 workspace projects",
      '{"source":"embedded-postgres@54623","status":"upToDate","pendingMigrations":[]}',
      "",
    ].join("\n");

    expect(parseJsonObjectFromCommandOutput(output)).toEqual({
      source: "embedded-postgres@54623",
      status: "upToDate",
      pendingMigrations: [],
    });
  });

  it("parses bounded JSON responses", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });

    await expect(parseJsonResponseWithLimit<{ ok: boolean }>(response, 64)).resolves.toEqual({ ok: true });
  });

  it("rejects oversized JSON responses before parsing them", async () => {
    const response = new Response(JSON.stringify({ payload: "x".repeat(128) }), {
      headers: { "content-type": "application/json" },
    });

    await expect(parseJsonResponseWithLimit(response, 32)).rejects.toThrow("Response exceeds 32 bytes");
  });
});
