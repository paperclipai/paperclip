// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceServicesDialog } from "./GoogleWorkspaceServices";

const listGrants = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: { listConnectionGrants: listGrants } }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

describe("Workspace service consent", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onContinue = vi.fn();
  const onCancel = vi.fn();
  const existing = { id: "workspace-account", status: "active", credentialPolicy: "per_user", config: {} } as ToolConnection;
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const click = async (name: string) => {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent === name)!;
    await act(async () => { button.click(); });
    await flush();
  };
  async function render(connection?: ToolConnection) {
    await act(async () => { root.render(<QueryClientProvider client={client}>
      <GoogleWorkspaceServicesDialog connection={connection} onContinue={onContinue} onCancel={onCancel} />
    </QueryClientProvider>); });
    await flush();
    await flush();
  }
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    client.clear();
    container.remove();
  });

  it("defaults all three groups to write and submits only their selections", async () => {
    await render();
    expect([...document.querySelectorAll('[role="switch"]')].map(item => item.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    expect([...document.querySelectorAll("select")].map(item => item.value)).toEqual(["write", "write", "write"]);
    expect(listGrants).not.toHaveBeenCalled();
    await click("Continue");
    expect(onContinue).toHaveBeenCalledWith({ gmail: "write", drive: "write", calendar: "write" });
  });

  it("restores the current user's saved request, not an organization or another user's broader grant", async () => {
    listGrants.mockResolvedValue({ currentUserId: "me", grants: [
      { kind: "organization", providerTenant: { oauth: { requestedScopes: ["https://www.googleapis.com/auth/documents"] } } },
      { kind: "user", subjectUserId: "other", providerTenant: { oauth: { requestedScopes: ["https://www.googleapis.com/auth/calendar.events"] } } },
      { kind: "user", subjectUserId: "me", providerTenant: { oauth: {
        requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/documents"],
      } } },
    ] });
    await render(existing);
    expect([...document.querySelectorAll('[role="switch"]')].map(item => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(document.querySelector("select")?.value).toBe("read");
    await click("Continue");
    expect(onContinue).toHaveBeenCalledWith({ gmail: "read" });
  });

  it("blocks on grant-load failure and retries without broadening the saved request", async () => {
    listGrants.mockRejectedValueOnce(new Error("unavailable"));
    await render(existing);
    expect(document.body.textContent).toContain("Could not load your saved service access");
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(onContinue).not.toHaveBeenCalled();
    listGrants.mockResolvedValue({ currentUserId: "me", grants: [] });
    await click("Try again");
    await flush();
    const continueButton = [...document.querySelectorAll("button")].find(item => item.textContent === "Continue")!;
    expect(continueButton.disabled).toBe(true);
    await click("Cancel");
    expect(onCancel).toHaveBeenCalledWith({});
    expect(onContinue).not.toHaveBeenCalled();
  });
});
