// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ToolCatalogEntry,
  ToolConnection,
  ToolProfileEntry,
  ToolProfileSummary,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
const setSearchParams = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  duplicateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  unbindProfile: vi.fn(),
}));
const profilesData = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(), setSearchParams],
  Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as never),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/api/tools", () => ({ toolsApi: api }));
vi.mock("./useProfilesData", () => ({ useProfilesData: () => profilesData.current }));

import { ProfileDetail } from "./ProfileDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(partial: Partial<ToolProfileSummary> = {}): ToolProfileSummary {
  return {
    accessMode: "selected",
    allowedToolCount: 1,
    allowedApplicationCount: 1,
    excludedToolCount: 0,
    totalToolCount: 2,
    assignmentCount: 1,
    appliesToAgentCount: 1,
    isCompanyDefault: false,
    ...partial,
  };
}

function entry(partial: Partial<ToolProfileEntry>): ToolProfileEntry {
  return {
    id: partial.id ?? "entry-1",
    companyId: "c1",
    profileId: "p1",
    selectorType: "application",
    effect: "include",
    applicationId: "app-gmail",
    connectionId: null,
    catalogEntryId: null,
    toolName: null,
    riskLevel: null,
    conditions: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function profile(partial: Partial<ToolProfileWithDetails> & { id?: string; name?: string } = {}): ToolProfileWithDetails {
  return {
    id: partial.id ?? "p1",
    companyId: "c1",
    profileKey: "everyday",
    name: partial.name ?? "Everyday work",
    description: "Routine work tools.",
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: null,
    createdAt: new Date("2026-06-10T00:00:00Z"),
    updatedAt: new Date("2026-06-11T00:00:00Z"),
    entries: [entry({})],
    bindings: [
      {
        id: "b1",
        companyId: "c1",
        profileId: "p1",
        targetType: "agent",
        targetId: "a1",
        priority: 0,
        metadata: null,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    summary: summary(),
    ...partial,
  } as ToolProfileWithDetails;
}

function tool(partial: Partial<ToolCatalogEntry>): ToolCatalogEntry {
  return {
    id: partial.id ?? "t1",
    companyId: "c1",
    applicationId: "app-gmail",
    connectionId: "conn-gmail",
    entryKind: "tool",
    toolName: "gmail.read",
    title: "Read mail",
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: "read",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    status: "active",
    addedAt: new Date(),
    version: null,
    schemaHash: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    reviewedAt: null,
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as ToolCatalogEntry;
}

function setData(profiles: ToolProfileWithDetails[], catalog: ToolCatalogEntry[] = [tool({})], connections: Partial<ToolConnection>[] = []) {
  profilesData.current = {
    profiles: { isLoading: false, isError: false, data: { profiles }, refetch: vi.fn() },
    connections: { data: { connections: [{ id: "conn-gmail", name: "Gmail", status: "active", healthStatus: "ok", ...connections[0] }] } },
    catalog,
    maps: {
      applicationsById: new Map([["app-gmail", "Gmail"]]),
      connectionsById: new Map([["conn-gmail", "Gmail"]]),
      agentsById: new Map([["a1", "Sage"]]),
      projectsById: new Map(),
      routinesById: new Map(),
    },
  };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ProfileDetail", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api.updateProfile.mockResolvedValue(profile());
    api.duplicateProfile.mockResolvedValue(profile({ id: "copy", name: "Copy" }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProfileDetail companyId="c1" profileId="p1" />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
  }

  it("renders detail sections with resolved allowed tools and assignments", async () => {
    setData([profile()]);
    await render();

    expect(container.textContent).toContain("Everyday work");
    expect(container.textContent).toContain("What it allows");
    expect(container.textContent).toContain("Read mail");
    expect(container.textContent).toContain("added by rule: all Gmail");
    expect(container.textContent).toContain("Who has it");
    expect(container.textContent).toContain("Sage");
    expect(container.textContent).toContain("New tools that appear later");
  });

  it("shows degraded app rows and the 0-tools warning state", async () => {
    setData([profile()], [tool({})], [
      { status: "disabled", healthStatus: "error" },
    ]);
    await render();

    expect(container.textContent).toContain("Gmail is disconnected");
    expect(container.textContent).toContain("Reconnect");
  });

  it("shows the 0-tools and unassigned warning states", async () => {
    setData([profile({ summary: summary({ allowedToolCount: 0, assignmentCount: 0, appliesToAgentCount: 0 }), entries: [], bindings: [] })], [tool({})]);
    await render();

    expect(container.textContent).toContain("allows 0 tools");
    expect(container.textContent).toContain("Not assigned yet");
  });

  it("validates duplicate profile names in the edit dialog", async () => {
    setData([profile(), profile({ id: "p2", name: "Existing name" })]);
    await render();

    const edit = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit");
    await act(async () => {
      edit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const input = document.body.querySelector("#edit-profile-name") as HTMLInputElement;
    await act(async () => {
      setNativeValue(input, "Existing name");
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Another profile already uses this name.");
  });

  it("shows archive and delete confirmation copy", async () => {
    setData([profile({ summary: summary({ assignmentCount: 2, appliesToAgentCount: 2, isCompanyDefault: true }) })]);
    await render();

    const archive = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Archive");
    await act(async () => {
      archive?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("This profile stops applying to 2 agents");

    await act(async () => {
      document.body.querySelector('[role="dialog"] button')?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await Promise.resolve();
    });
  });
});
