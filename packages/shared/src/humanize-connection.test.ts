import { describe, expect, it } from "vitest";
import {
  connectionDisplaySecondaryHint,
  humanizeConnectionDisplayName,
} from "./humanize-connection.js";

describe("humanizeConnectionDisplayName", () => {
  it("hides raw IPs / hosts behind a generic label", () => {
    expect(humanizeConnectionDisplayName("127.0.0.1")).toBe("Custom app");
    expect(humanizeConnectionDisplayName("127.0.0.1:8931")).toBe("Custom app");
    expect(humanizeConnectionDisplayName("localhost")).toBe("Custom app");
    expect(humanizeConnectionDisplayName("example.com:8080")).toBe("Custom app");
    expect(humanizeConnectionDisplayName("https://mcp.example.com/sse")).toBe("Custom app");
  });

  it("drops the `Plugin:` prefix and title-cases the package leaf", () => {
    expect(humanizeConnectionDisplayName("Plugin: paperclipai.plugin-briefs")).toBe("Briefs");
    expect(humanizeConnectionDisplayName("Plugin: acme.plugin-weekly-report")).toBe(
      "Weekly Report",
    );
  });

  it("turns `vendor:tool` ids into Title Case With Spaces", () => {
    expect(humanizeConnectionDisplayName("mcp-remote-fixture:update_note")).toBe("Update Note");
    expect(humanizeConnectionDisplayName("github:create_issue")).toBe("Create Issue");
  });

  it("title-cases a bare snake/kebab identifier", () => {
    expect(humanizeConnectionDisplayName("update_note")).toBe("Update Note");
    expect(humanizeConnectionDisplayName("send-email")).toBe("Send Email");
  });

  it("passes through normal, already-human app names", () => {
    expect(humanizeConnectionDisplayName("Zapier")).toBe("Zapier");
    expect(humanizeConnectionDisplayName("Notion")).toBe("Notion");
    expect(humanizeConnectionDisplayName("Google Drive")).toBe("Google Drive");
  });

  it("prefers an explicit title when provided", () => {
    expect(
      humanizeConnectionDisplayName("mcp-remote-fixture:update_note", { title: "Update note" }),
    ).toBe("Update note");
    // Blank/whitespace titles fall back to derivation.
    expect(humanizeConnectionDisplayName("update_note", { title: "  " })).toBe("Update Note");
  });

  it("accepts a connection-like object and handles empty input", () => {
    expect(humanizeConnectionDisplayName({ name: "Plugin: acme.plugin-briefs" })).toBe("Briefs");
    expect(humanizeConnectionDisplayName("")).toBe("Custom app");
    expect(humanizeConnectionDisplayName(null)).toBe("Custom app");
  });
});

describe("connectionDisplaySecondaryHint", () => {
  it("surfaces `hosted at …` only for network addresses", () => {
    expect(connectionDisplaySecondaryHint("127.0.0.1")).toBe("hosted at 127.0.0.1");
    expect(connectionDisplaySecondaryHint("127.0.0.1:8931")).toBe("hosted at 127.0.0.1:8931");
    expect(connectionDisplaySecondaryHint({ name: "Zapier" })).toBeNull();
    expect(connectionDisplaySecondaryHint("Plugin: acme.plugin-briefs")).toBeNull();
    expect(connectionDisplaySecondaryHint("")).toBeNull();
  });
});
