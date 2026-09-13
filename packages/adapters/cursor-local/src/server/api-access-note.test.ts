import { describe, expect, it } from "vitest";
import { renderApiAccessNote } from "./execute.js";

describe("renderApiAccessNote", () => {
  it("is empty when Paperclip API credentials are not in the run env", () => {
    expect(renderApiAccessNote({})).toBe("");
    expect(renderApiAccessNote({ PAPERCLIP_API_URL: "https://example.test" })).toBe("");
    expect(renderApiAccessNote({ PAPERCLIP_API_KEY: "token" })).toBe("");
  });

  it("tells the agent to send the run-id header once credentials are present", () => {
    const note = renderApiAccessNote({
      PAPERCLIP_API_URL: "https://example.test",
      PAPERCLIP_API_KEY: "token",
    });
    expect(note).toContain("Include X-Paperclip-Run-Id on mutating requests.");
  });
});
