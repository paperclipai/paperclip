// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { googleWorkspaceSelectedScopes, type ToolConnection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceServicesDialog } from "./GoogleWorkspaceServices";
import { GOOGLE_WORKSPACE_PRIVACY_POLICY_URL, googleWorkspaceDataUseDisclosure } from "./googleWorkspaceDisclosure";

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

const GMAIL_SEND_NOTE = "Google's permission screen also mentions sending email; Paperclip does not send email.";

describe("Google Workspace data-use disclosure", () => {
  const use = [
    "Agents read this content only to do the tasks you give them.",
    "To do that, the content is sent to the AI model provider configured for your workspace.",
    "It is not used to train general AI models.",
    "Results are saved in the task and its run history. They stay there until you delete them, even after you disconnect.",
  ];

  it.each([
    [{ gmail: "read" }, ["Gmail: agents can read and search your email."]],
    [{ gmail: "write" }, ["Gmail: agents can read and search your email, and create drafts. Google's permission screen also mentions sending email; Paperclip does not send email."]],
    [{ drive: "read" }, ["Drive: agents can read and search your files, Docs, Sheets and Slides."]],
    [{ drive: "write" }, ["Drive: agents can read and search your files, Docs, Sheets and Slides. They can also create files and edit Docs, Sheets and Slides."]],
    [{ calendar: "read" }, ["Calendar: agents can see your calendars, events and free/busy times."]],
    [{ calendar: "write" }, ["Calendar: agents can see your calendars, events and free/busy times. They can also create, change and delete events, and respond to invitations."]],
  ] as const)("describes only the selected service (%o)", (selection, access) => {
    expect(googleWorkspaceDataUseDisclosure(selection)).toEqual({ access, use });
  });

  it("lists every selected service in picker order and always explains sharing", () => {
    const disclosure = googleWorkspaceDataUseDisclosure({ calendar: "read", gmail: "write", drive: "read" });
    expect(disclosure.access.map(line => line.split(":")[0])).toEqual(["Gmail", "Drive", "Calendar"]);
    expect(disclosure.use).toContain("To do that, the content is sent to the AI model provider configured for your workspace.");
  });

  it("never claims Gmail can send: read only never mentions sending, read & write only says Paperclip does not send", () => {
    const text = (gmail: "read" | "write") => {
      const { access, use } = googleWorkspaceDataUseDisclosure({ gmail });
      return [...access, ...use].join(" ");
    };
    expect(text("read")).not.toMatch(/send/i);
    expect(text("write")).toContain("Paperclip does not send email.");
    expect(text("write").replace(GMAIL_SEND_NOTE, "")).not.toMatch(/send/i);
  });

  it("says nothing with no services selected", () => {
    expect(googleWorkspaceDataUseDisclosure({})).toEqual({ access: [], use: [] });
  });
});

describe("Workspace picker disclosure", () => {
  let root: Root;
  let container: HTMLDivElement;
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  async function render(initial?: Record<string, "read" | "write">) {
    await act(async () => { root.render(<QueryClientProvider client={new QueryClient()}>
      <GoogleWorkspaceServicesDialog initial={initial} onContinue={vi.fn()} onCancel={vi.fn()} />
    </QueryClientProvider>); });
    await flush();
  }
  const disclosure = () => document.querySelector('[aria-label="How Paperclip uses your Google data"]');

  it("shows the selected services, sharing and privacy policy before Continue", async () => {
    await render({ gmail: "write", calendar: "read" });
    const block = disclosure()!;
    expect(block.textContent).toContain("Gmail: agents can read and search your email, and create drafts. Google's permission screen also mentions sending email; Paperclip does not send email.");
    expect(block.textContent).toContain("Calendar: agents can see your calendars, events and free/busy times.");
    expect(block.textContent).not.toContain("Drive");
    expect(block.textContent!.replace(GMAIL_SEND_NOTE, "")).not.toMatch(/\bsend/i);
    expect(block.textContent).toContain("the content is sent to the AI model provider configured for your workspace");
    const link = block.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(GOOGLE_WORKSPACE_PRIVACY_POLICY_URL);
    expect(GOOGLE_WORKSPACE_PRIVACY_POLICY_URL).toBe("https://paperclip.ing/privacy");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.textContent).toContain("Limited Use");
    const footer = document.querySelector("footer")!;
    expect(block.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("follows the selection as services are turned off", async () => {
    await render({ drive: "read" });
    expect(disclosure()!.textContent).toContain("Drive: agents can read and search your files");
    const toggle = document.querySelector<HTMLButtonElement>("#workspace-service-drive")!;
    await act(async () => { toggle.click(); });
    expect(disclosure()).toBeNull();
    expect(document.body.textContent).toContain("Select at least one service to continue.");
  });
});
