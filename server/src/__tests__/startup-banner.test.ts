import { describe, expect, it } from "vitest";
import { renderDevReadyBox } from "../startup-banner.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderDevReadyBox", () => {
  it("renders box with correct rows for loopback/local_trusted", () => {
    const lines = renderDevReadyBox({
      uiUrl: "http://127.0.0.1:3100/",
      apiUrl: "http://127.0.0.1:3100/api/",
      bind: "loopback",
      deploymentMode: "local_trusted",
    });

    const plain = lines.map(stripAnsi);

    expect(plain[0]).toMatch(/^╭─+╮$/);
    expect(plain[plain.length - 1]).toMatch(/^╰─+╯$/);

    const content = plain.slice(1, -1);
    expect(content[0]).toContain("Paperclip dev is ready");
    expect(content[1]).toContain("Web UI : http://127.0.0.1:3100/");
    expect(content[2]).toContain("API    : http://127.0.0.1:3100/api/");
    expect(content[3]).toContain("Bind   : loopback (mode: local_trusted)");
    expect(content[4]).toContain("Stop   : pnpm dev:stop");
  });

  it("renders box with resolved tailnet host for bind=tailnet", () => {
    const lines = renderDevReadyBox({
      uiUrl: "http://100.105.225.115:3100/",
      apiUrl: "http://100.105.225.115:3100/api/",
      bind: "tailnet",
      deploymentMode: "authenticated",
    });

    const plain = lines.map(stripAnsi);
    const content = plain.slice(1, -1);

    expect(content[1]).toContain("Web UI : http://100.105.225.115:3100/");
    expect(content[2]).toContain("API    : http://100.105.225.115:3100/api/");
    expect(content[3]).toContain("Bind   : tailnet (mode: authenticated)");
  });

  it("renders box with lan host for bind=lan", () => {
    const lines = renderDevReadyBox({
      uiUrl: "http://localhost:3100/",
      apiUrl: "http://localhost:3100/api/",
      bind: "lan",
      deploymentMode: "authenticated",
    });

    const plain = lines.map(stripAnsi);
    const content = plain.slice(1, -1);

    expect(content[1]).toContain("Web UI : http://localhost:3100/");
    expect(content[3]).toContain("Bind   : lan (mode: authenticated)");
  });

  it("auto-sizes the box width to fit the longest line", () => {
    const shortLines = renderDevReadyBox({
      uiUrl: "http://127.0.0.1:3100/",
      apiUrl: "http://127.0.0.1:3100/api/",
      bind: "loopback",
      deploymentMode: "local_trusted",
    }).map(stripAnsi);

    const longLines = renderDevReadyBox({
      uiUrl: "http://100.105.225.115:3100/",
      apiUrl: "http://100.105.225.115:3100/api/",
      bind: "tailnet",
      deploymentMode: "authenticated",
    }).map(stripAnsi);

    expect(longLines[0].length).toBeGreaterThan(shortLines[0].length);
  });

  it("all content rows have equal visual width matching the border", () => {
    const lines = renderDevReadyBox({
      uiUrl: "http://100.105.225.115:3100/",
      apiUrl: "http://100.105.225.115:3100/api/",
      bind: "tailnet",
      deploymentMode: "authenticated",
    }).map(stripAnsi);

    const borderWidth = lines[0].length;
    for (const line of lines) {
      expect(line.length).toBe(borderWidth);
    }
  });
});
