// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import { OAuthConnectStateScreen, type OAuthConnectPhase } from "./ConnectionSetupFlow";

vi.mock("@/api/tools", () => ({ toolsApi: {} }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

describe("Google Workspace sign-in state screen", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(phase: OAuthConnectPhase, error?: string) {
    await act(async () => {
      root.render(
        <OAuthConnectStateScreen
          entry={getConnectableAppDefinition("google-workspace")}
          phase={phase}
          error={error}
          onRetry={() => undefined}
          onBack={() => undefined}
          onCancel={() => undefined}
        />,
      );
    });
  }

  const links = () => [...container.querySelectorAll("a")].map((link) => link.getAttribute("href") ?? "");

  it.each<[string, OAuthConnectPhase, string | undefined]>([
    ["opening the sign-in", "redirecting", undefined],
    ["preparing the sign-in", "starting", undefined],
    ["failing to open the sign-in window", "error", "Paperclip couldn’t open the sign-in window."],
  ])("shows no MCP wording or MCP guide link while %s", async (_label, phase, error) => {
    await render(phase, error);
    expect(container.textContent).toContain("Connect Google Workspace");
    expect(container.textContent).toContain("Secure sign-in");
    expect(container.textContent).not.toMatch(/\bMCP\b/);
    expect(links().some((href) => href.includes("configure-mcp-servers"))).toBe(false);
  });

  it("keeps the MCP label for a server the user pasted", async () => {
    await act(async () => {
      root.render(
        <OAuthConnectStateScreen
          identity={{ name: "Example", unverifiedHost: "mcp.example.com" }}
          phase="redirecting"
          onRetry={() => undefined}
          onBack={() => undefined}
          onCancel={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain("Secure MCP sign-in");
  });
});
