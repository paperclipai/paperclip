// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelsPage } from "./ChannelsPage";
import type { Channel, ChannelMessage } from "@/api/channels";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1" as string | null,
  selectedCompany: { id: "company-1", issuePrefix: "PAP", channelsEnabled: true } as Record<
    string,
    unknown
  > | null,
  companies: [] as unknown[],
  reloadCompanies: vi.fn(async () => {}),
}));

const breadcrumbState = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));

const channelsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  listMessages: vi.fn(),
  listThread: vi.fn(),
  presence: vi.fn(),
  markRead: vi.fn(),
  postMessage: vi.fn(),
  enableChannels: vi.fn(),
  materialize: vi.fn(),
}));

const attentionApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => companyState,
  useOptionalCompany: () => companyState,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("@/api/channels", () => ({ channelsApi: channelsApiMock }));
vi.mock("@/api/attention", () => ({ attentionApi: attentionApiMock }));
vi.mock("@/lib/home-surface", () => ({
  saveLastHomeSurface: vi.fn(),
}));

function sampleChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    companyId: "company-1",
    kind: "project",
    name: "launch",
    slug: "launch",
    topic: "Ship the launch",
    projectId: "project-1",
    dmFingerprint: null,
    createdByUserId: null,
    createdByAgentId: null,
    archivedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    unreadCount: 2,
    ...overrides,
  };
}

function sampleMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "message-1",
    companyId: "company-1",
    channelId: "channel-1",
    authorType: "user",
    authorId: "user-1",
    messageType: "user",
    body: "Draft the launch checklist",
    threadRootId: null,
    replyToId: null,
    replyCount: 3,
    lastReplyAt: "2026-07-02T00:00:00.000Z",
    issueId: "issue-1",
    heartbeatRunId: null,
    workProductId: null,
    interactionId: null,
    approvalId: null,
    documentId: null,
    cardKind: "task",
    channelWorkMode: "work",
    mentionedAgentIds: [],
    mentionedUserIds: [],
    metadata: null,
    deletedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    issueIdentifier: "PAP-42",
    authorName: "Ada",
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderChannels(container: HTMLDivElement, path = "/channels/channel-1") {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/channels" element={<ChannelsPage />} />
            <Route path="/channels/:channelId" element={<ChannelsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("ChannelsPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState.selectedCompanyId = "company-1";
    companyState.selectedCompany = {
      id: "company-1",
      issuePrefix: "PAP",
      channelsEnabled: true,
    };
    breadcrumbState.setBreadcrumbs.mockReset();
    for (const fn of Object.values(channelsApiMock)) fn.mockReset();
    attentionApiMock.list.mockReset();
    channelsApiMock.list.mockResolvedValue([sampleChannel()]);
    channelsApiMock.listMessages.mockResolvedValue({ messages: [sampleMessage()], nextCursor: null });
    channelsApiMock.presence.mockResolvedValue([]);
    channelsApiMock.markRead.mockResolvedValue({ ok: true });
    channelsApiMock.materialize.mockResolvedValue({ created: 0 });
    attentionApiMock.list.mockResolvedValue({
      companyId: "company-1",
      generatedAt: "2026-07-01T00:00:00.000Z",
      totalCount: 0,
      countsBySourceKind: {},
      items: [],
    });
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the channel timeline with task roots and the composer", async () => {
    renderChannels(container);

    await waitForAssertion(() => {
      expect(container.querySelectorAll("[data-testid='channel-root-message']").length).toBe(1);
    });
    expect(container.textContent).toContain("Draft the launch checklist");
    expect(container.textContent).toContain("PAP-42");
    expect(container.querySelector("[data-testid='chat-composer']")).not.toBeNull();
    expect(channelsApiMock.listMessages).toHaveBeenCalledWith("company-1", "channel-1", {
      includeCompleted: false,
    });
  });

  it("offers the opt-in state when the company has channels disabled", async () => {
    companyState.selectedCompany = {
      id: "company-1",
      issuePrefix: "PAP",
      channelsEnabled: false,
    };
    renderChannels(container, "/channels");

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Turn on Channels");
    });
    expect(container.textContent).toContain("Enable Channels");
    expect(channelsApiMock.list).not.toHaveBeenCalled();
  });

  it("stays usable when the messages endpoint is not live yet", async () => {
    channelsApiMock.listMessages.mockRejectedValue(new Error("Not Found"));
    renderChannels(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Couldn’t load this channel’s tasks yet");
    });
    expect(container.querySelector("[data-testid='chat-composer']")).not.toBeNull();
  });
});
