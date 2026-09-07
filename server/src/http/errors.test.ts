import { describe, expect, it } from "bun:test";
import { conflict, forbidden } from "../errors.js";
import { toHttpErrorResponse } from "./errors.js";

describe("HTTP error boundary", () => {
  it("preserves domain error status, message, and details", async () => {
    const response = toHttpErrorResponse(
      forbidden("Viewer access is read-only", { code: "viewer_read_only" }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Viewer access is read-only",
      details: { code: "viewer_read_only" },
    });
  });

  it("maps unknown failures to a redacted 500 response", async () => {
    const response = toHttpErrorResponse(new Error("database password leaked"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("preserves conflict status without inventing details", async () => {
    const response = toHttpErrorResponse(conflict("Issue already checked out"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Issue already checked out" });
  });
});
