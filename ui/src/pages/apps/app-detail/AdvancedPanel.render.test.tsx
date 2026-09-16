// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { DangerZone } from "./AdvancedPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

let container: HTMLDivElement | null = null;

afterEach(() => {
  container?.remove();
  container = null;
});

function renderDangerZone() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<DangerZone appName="PostHog" removing={false} onRemove={vi.fn()} />));
  return container;
}

function renderComposioDangerZone() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(
    <DangerZone appName="Composio" childConnectionCount={2} removing={false} onRemove={vi.fn()} />,
  ));
  return container;
}

function expandDangerZone(node: HTMLDivElement) {
  const trigger = Array.from(node.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Danger zone"));
  expect(trigger).toBeTruthy();
  act(() => trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/**
 * Remove app deletes the operator's credentials and revokes agent access
 * (PAP-17119). The compact confirmation still names both effects before the
 * operator commits.
 */
describe("DangerZone", () => {
  it("keeps removal available without reconnecting an obsolete Anthropic method", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onRemove = vi.fn();
    act(() => root.render(
      <DangerZone
        appName="Anthropic"
        connection={{
          id: "obsolete-anthropic",
          uid: "obsolete-anthropic",
          companyId: "company-1",
          applicationId: "app-1",
          name: "Anthropic",
          connectionKind: "managed",
          connectionPurpose: "tool",
          ownership: "customer",
          transport: "rest_api",
          authKind: "api_key",
          credentialSource: "paperclip_vault",
          credentialPolicy: "shared",
          transportConfig: {},
          config: { sourceTemplateKey: "anthropic", connectionMethodKey: "api-key" },
          credentialSecretRefs: [],
          healthStatus: "error",
          healthCheckedAt: null,
          lastError: "This connection has no supported tool integration.",
          enabled: true,
          createdByAgentId: null,
          createdByUserId: "user-1",
          createdAt: new Date("2026-09-12T00:00:00Z"),
          updatedAt: new Date("2026-09-12T00:00:00Z"),
        }}
        galleryEntry={getAppStoreDefinition("anthropic")!}
        removing={false}
        onRemove={onRemove}
      />,
    ));
    expandDangerZone(container);
    const button = (label: string) => Array.from(container!.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim() === label);
    expect(button("Reconnect")).toBeUndefined();
    act(() => button("Remove app")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => button("Yes, remove it")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onRemove).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("keeps dangerous actions folded by default", () => {
    const node = renderDangerZone();

    expect(node.textContent).toContain("Danger zone");
    expect(node.textContent).not.toContain("Remove app");
    expect(node.textContent).not.toContain("Deletes credentials");
  });

  it("promises credential deletion and re-authentication before the operator confirms", () => {
    const node = renderDangerZone();
    expandDangerZone(node);
    const text = node.textContent ?? "";

    expect(text).toContain("Deletes credentials for PostHog");
    expect(text).toContain("removes agent access");
    expect(text).toContain("requires a new sign-in or key");
  });

  it("keeps the warning visible in the confirming state", () => {
    const node = renderDangerZone();
    expandDangerZone(node);
    const trigger = Array.from(node.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Remove app");
    expect(trigger).toBeTruthy();

    act(() => trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const text = node.textContent ?? "";
    expect(text).toContain("Yes, remove it");
    expect(text).toContain("Deletes credentials for PostHog");
    expect(text).toContain("requires a new sign-in or key");
  });

  it("names every child service that parent removal will take down", () => {
    const node = renderComposioDangerZone();
    expandDangerZone(node);
    expect(node.textContent).toContain("2 connected services");
  });
});
