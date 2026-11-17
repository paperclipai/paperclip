import { describe, expect, it } from "vitest";
import { connectionAgentInstructionsSchema } from "./connection-instructions.js";
import { isSamePaperclipInstance, paperclipPeerAgentInstructions, paperclipPeerFromMcpUrl, paperclipPeerInstructionTemplate } from "./paperclip-peer.js";

describe("paperclipPeerFromMcpUrl", () => {
  it.each([
    ["https://acme.paperclip.app/mcp/paperclip", "acme", "acme Paperclip"],
    ["https://paperclip.staging.paperclip.app/mcp/paperclip/", "staging", "staging Paperclip"],
    ["https://pc.example.com/mcp/paperclip", "pc", "pc Paperclip"],
    ["https://example.com/mcp/paperclip", "example", "example Paperclip"],
    ["http://localhost:3101/mcp/paperclip", "localhost-3101", "localhost-3101 Paperclip"],
    ["http://127.0.0.1:3101/mcp/paperclip", "127-0-0-1-3101", "127-0-0-1-3101 Paperclip"],
    ["https://paperclip.app/mcp/paperclip", "paperclip", "Paperclip paperclip.app"],
  ])("names %s after the instance it reaches", (url, label, name) => {
    expect(paperclipPeerFromMcpUrl(url)).toMatchObject({ label, name });
  });

  it("derives a tool prefix from the address, with the distinctive part first", () => {
    expect(paperclipPeerFromMcpUrl("https://acme.paperclip.app/mcp/paperclip")?.toolNamespace).toBe("acme-paperclip");
    expect(paperclipPeerFromMcpUrl("https://paperclip.app/mcp/paperclip")?.toolNamespace).toBe("paperclip");
  });

  it.each([
    "https://acme.paperclip.app/mcp",
    "https://acme.paperclip.app/mcp/paperclip/extra",
    "https://mcp.example.com/sse",
    "ftp://acme.paperclip.app/mcp/paperclip",
    "not a url",
    "",
    null,
  ])("ignores %s", (url) => {
    expect(paperclipPeerFromMcpUrl(url)).toBeNull();
  });
});

describe("isSamePaperclipInstance", () => {
  const peer = (url: string) => paperclipPeerFromMcpUrl(url)!;

  it("matches the instance's own public origin", () => {
    expect(isSamePaperclipInstance(peer("https://acme.paperclip.app/mcp/paperclip"), [null, "https://acme.paperclip.app"])).toBe(true);
  });

  it("treats loopback hostnames on the same port as the same instance", () => {
    expect(isSamePaperclipInstance(peer("http://127.0.0.1:3100/mcp/paperclip"), ["http://localhost:3100"])).toBe(true);
  });

  it("keeps another local instance on a different port distinct", () => {
    expect(isSamePaperclipInstance(peer("http://localhost:3101/mcp/paperclip"), ["http://localhost:3100"])).toBe(false);
  });

  it("keeps another hosted instance distinct", () => {
    expect(isSamePaperclipInstance(peer("https://bob.paperclip.app/mcp/paperclip"), ["https://acme.paperclip.app", "not a url"])).toBe(false);
  });
});

describe("paperclipPeerAgentInstructions", () => {
  it("names the other instance, steers own work back home, and fits the instruction limits", () => {
    const instructions = paperclipPeerAgentInstructions(peer());
    expect(connectionAgentInstructionsSchema.parse(instructions)).toEqual(instructions);
    expect(instructions.enabled).toBe(true);
    expect(instructions.template).toEqual({ id: "paperclip.peer", version: 1 });
    expect(instructions.text).toBe(paperclipPeerInstructionTemplate(peer()).text);
    expect(instructions.text).toContain("https://acme.paperclip.app");
    expect(instructions.text).toContain("not the Paperclip you work in");
    expect(instructions.text).toContain("keep using your own Paperclip tools");
  });

  function peer() {
    return paperclipPeerFromMcpUrl("https://acme.paperclip.app/mcp/paperclip")!;
  }
});
