import { describe, expect, it } from "bun:test";
import { toHeaderSource } from "./request-headers.js";

describe("HTTP request header boundary", () => {
  it("normalizes Web Request headers for credential resolvers", () => {
    const request = new Request("http://localhost/api/health", {
      headers: {
        Authorization: "Bearer token",
        "X-Paperclip-Run-Id": "run-1",
        "X-Paperclip-Cloud-User-Name": "Board",
      },
    });

    const source = toHeaderSource(request);

    expect(source.header("authorization")).toBe("Bearer token");
    expect(source.header("X-Paperclip-Run-Id")).toBe("run-1");
    expect(source.header("x-paperclip-cloud-user-name")).toBe("Board");
  });

  it("returns undefined for missing headers", () => {
    const source = toHeaderSource(new Request("http://localhost/api/health"));

    expect(source.header("authorization")).toBeUndefined();
  });

  it("does not expose a mutable header map", () => {
    const source = toHeaderSource(
      new Request("http://localhost/api/health", {
        headers: { Authorization: "Bearer token" },
      }),
    );

    expect(Object.isFrozen(source)).toBe(true);
  });
});
