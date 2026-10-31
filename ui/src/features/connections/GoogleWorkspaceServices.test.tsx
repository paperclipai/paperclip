// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { googleWorkspaceSelectedScopes, type ToolConnection } from "@paperclipai/shared";
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
    listGrants.mockResolvedValue({ currentUserId: "me", grants: [] });
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

  it("restores a cold draft's selected services after declined OAuth", async () => {
    await render({ ...existing, companyId: "company-1", status: "draft", config: {
      workspaceSetup: {
        version: 1, companyId: "company-1", connectionId: existing.id,
        actorType: "user", actorId: "me", grantKind: "user", subjectId: "me",
        requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
      oauth: { scopes: ["https://www.googleapis.com/auth/documents"] },
    } });
    expect([...document.querySelectorAll('[role="switch"]')].map(item => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(document.querySelector("select")?.value).toBe("read");
    await click("Continue");
    expect(onContinue).toHaveBeenCalledWith({ gmail: "read" });
  });

  it.each([undefined, "another-user"])("requires a deliberate choice for an unbound draft (%s)", async (actorId) => {
    await render({ ...existing, companyId: "company-1", status: "draft", config: {
      ...(actorId ? { workspaceSetup: {
        version: 1, companyId: "company-1", connectionId: existing.id,
        actorType: "user", actorId, grantKind: "user", subjectId: "me",
        requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      } } : {}),
      oauth: { scopes: ["https://www.googleapis.com/auth/documents"] },
    } });
    expect([...document.querySelectorAll('[role="switch"]')].map(item => item.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    const proceed = [...document.querySelectorAll("button")].find(item => item.textContent === "Continue")!;
    expect(proceed.disabled).toBe(true);
    expect(onContinue).not.toHaveBeenCalled();
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

  it("restores only the addressed user's pending services on a saved draft", async () => {
    listGrants.mockResolvedValue({ currentUserId: "me", grants: [] });
    await render({ ...existing, status: "draft", config: { oauth: { pendingWorkspaceServiceRequests: {
      me: { requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"], requestedAt: "2026-10-26T10:00:00Z" },
      other: { requestedScopes: ["https://www.googleapis.com/auth/documents"], requestedAt: "2026-10-26T10:00:00Z" },
    } } } });
    await click("Continue");
    expect(listGrants).toHaveBeenCalledWith(existing.id);
    expect(onContinue).toHaveBeenCalledWith({ gmail: "read" });
  });

  it.each([true, false])("uses pending consent only when newer than the saved grant (newer: %s)", async newer => {
    listGrants.mockResolvedValue({ currentUserId: "me", grants: [{
      kind: "user", subjectUserId: "me", updatedAt: "2026-10-26T10:00:00Z",
      providerTenant: { oauth: { requestedScopes: googleWorkspaceSelectedScopes({ drive: "write" }), consentedAt: "2026-10-26T10:00:00Z" } },
    }] });
    await render({ ...existing, config: { oauth: { pendingWorkspaceServiceRequests: {
      me: { requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"], requestedAt: newer ? "2026-10-26T11:00:00Z" : "2026-10-26T09:00:00Z" },
    } } } });
    await click("Continue");
    expect(onContinue).toHaveBeenCalledWith(newer ? { gmail: "read" } : { drive: "write" });
  });
  it.each([false, true])("preserves pending service choices through token refresh (legacy grant: %s)", async legacy => {
    listGrants.mockResolvedValue({ currentUserId: "me", grants: [{
      kind: "user", subjectUserId: "me", createdAt: "2026-10-26T10:00:00Z", updatedAt: "2026-10-26T12:00:00Z",
      providerTenant: { oauth: { requestedScopes: googleWorkspaceSelectedScopes({ drive: "write" }),
        ...(legacy ? {} : { consentedAt: "2026-10-26T10:00:00Z" }), refreshedAt: "2026-10-26T12:00:00Z" } },
    }] });
    await render({ ...existing, config: { oauth: { pendingWorkspaceServiceRequests: {
      me: { requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"], requestedAt: "2026-10-26T11:00:00Z" },
    } } } });
    await click("Continue");
    expect(onContinue).toHaveBeenCalledWith({ gmail: "read" });
  });

});
