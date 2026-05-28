import { describe, expect, it } from "vitest";
import { PaperclipApiClient } from "../client/http.js";

const VALID_RUN_ID = "0190f8e2-7b6c-7c1f-9e7f-3d3f4a2b1c8a";

describe("PaperclipApiClient runId validation", () => {
  it("accepts a canonical UUID", () => {
    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      runId: VALID_RUN_ID,
    });
    expect(client.runId).toBe(VALID_RUN_ID);
  });

  it("normalizes uppercase to lowercase", () => {
    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      runId: VALID_RUN_ID.toUpperCase(),
    });
    expect(client.runId).toBe(VALID_RUN_ID);
  });

  it("treats missing runId as undefined (no header)", () => {
    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });
    expect(client.runId).toBeUndefined();
  });

  it("treats empty/whitespace runId as undefined (no header)", () => {
    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      runId: "   ",
    });
    expect(client.runId).toBeUndefined();
  });

  it("throws on invalid runId (smoke-script pattern)", () => {
    expect(
      () =>
        new PaperclipApiClient({
          apiBase: "http://localhost:3100",
          runId: "smoke-run-1717000000",
        }),
    ).toThrow(/Invalid --run-id.*smoke-run-1717000000/);
  });

  it("throws on invalid runId (manual session pattern)", () => {
    expect(
      () =>
        new PaperclipApiClient({
          apiBase: "http://localhost:3100",
          runId: "manual-smilerite-20260527T141106Z",
        }),
    ).toThrow(/Invalid --run-id/);
  });
});
