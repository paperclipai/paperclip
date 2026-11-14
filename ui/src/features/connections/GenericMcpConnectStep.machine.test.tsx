// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newCustomHeaderRow } from "@/pages/apps/generic-mcp-connect";
import { GenericMcpConnectStep } from "./GenericMcpConnectStep";

vi.mock("@/api/tools", () => ({ toolsApi: {} }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

describe("Machine sign-in in the custom server step", () => {
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

  async function render(machineSignIn: { companyId: string; onConnected: () => void } | null) {
    await act(async () => {
      root.render(
        <GenericMcpConnectStep
          link="https://mcp.example/mcp" name="" needsKey={false} keyValue="" onKeyChange={() => undefined}
          authMode="auto" onAuthModeChange={() => undefined} headers={[newCustomHeaderRow()]} onHeadersChange={() => undefined}
          oauthClientId="" onOAuthClientIdChange={() => undefined} oauthClientSecret="" onOAuthClientSecretChange={() => undefined}
          advancedOpen onAdvancedOpenChange={() => undefined} guidance={null} submitting={false}
          onBack={() => undefined} onConnect={() => undefined} machineSignIn={machineSignIn}
          defaults={<p data-testid="access-defaults">Connects for every agent. Change</p>}
        />,
      );
    });
  }
  const buttons = () => [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");

  it("is offered for organization connections and replaces Check link with its own setup", async () => {
    await render({ companyId: "company-1", onConnected: () => undefined });
    const option = [...container.querySelectorAll('[role="radio"]')].find((item) => item.textContent?.includes("Machine sign-in"));
    expect(option).toBeDefined();
    expect(buttons()).toContain("Check link");
    await act(async () => { (option as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="machine-sign-in-setup"]')).not.toBeNull();
    expect(buttons()).not.toContain("Check link");
    expect(buttons()).toContain("Create key");
    // Who gets access stays visible and changeable while machine setup is open.
    expect(container.querySelector('[data-testid="access-defaults"]')).not.toBeNull();
  });

  it("keeps machine sign-in open when arrow keys move its own method choice", async () => {
    await render({ companyId: "company-1", onConnected: () => undefined });
    const option = [...container.querySelectorAll('[role="radio"]')].find((item) => item.textContent?.includes("Machine sign-in"));
    await act(async () => { (option as HTMLElement).click(); });
    const inner = [...container.querySelectorAll('[role="radio"]')].find((item) => item.textContent === "Paperclip key (recommended)") as HTMLElement;
    await act(async () => { inner.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(container.querySelector('[data-testid="machine-sign-in-setup"]')).not.toBeNull();
    const secret = [...container.querySelectorAll('[role="radio"]')].find((item) => item.textContent === "Client secret");
    expect(secret?.getAttribute("aria-checked")).toBe("true");
  });

  it("is not offered for personal connections", async () => {
    await render(null);
    expect(container.textContent).not.toContain("Machine sign-in");
  });
});
