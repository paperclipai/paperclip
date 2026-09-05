import { describe, expect, it } from "vitest";
import { projectSafeChatPublication } from "./chat-publication-projection.js";

describe("chat run milestone projection", () => {
  it("allows only safe lifecycle state and text through the shared projection", () => {
    expect(
      projectSafeChatPublication({
        classification: "external",
        source: "safe_milestone",
        text: "Maya is working…",
        progressState: "working",
      }),
    ).toEqual({ text: "Maya is working…", progressState: "working" });
    expect(
      JSON.stringify(
        projectSafeChatPublication({
          classification: "external",
          source: "safe_milestone",
          text: "Maya stopped before completing this turn.",
          progressState: "failed",
        }),
      ),
    ).not.toContain("stderr");
  });
});
