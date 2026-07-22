import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { shouldCompressHttpResponse } from "../app.js";

function responseWithContentType(contentType: string): Response {
  return {
    getHeader: (name: string) =>
      name.toLowerCase() === "content-type" ? contentType : undefined,
  } as unknown as Response;
}

const request = { headers: {} } as Request;

describe("HTTP response compression", () => {
  it("compresses ordinary JSON responses", () => {
    expect(
      shouldCompressHttpResponse(
        request,
        responseWithContentType("application/json; charset=utf-8"),
      ),
    ).toBe(true);
  });

  it("leaves server-sent event streams unbuffered", () => {
    expect(
      shouldCompressHttpResponse(
        request,
        responseWithContentType("text/event-stream; charset=utf-8"),
      ),
    ).toBe(false);
  });
});
