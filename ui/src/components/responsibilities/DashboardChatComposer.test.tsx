// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { DashboardChatComposer } from "./DashboardChatComposer";

const mocks = vi.hoisted(() => ({
  composer: null as null | Record<string, any>,
  navigate: vi.fn(),
  chats: { ensure: vi.fn() },
  issues: { addComment: vi.fn(), getCore: vi.fn(), update: vi.fn(), uploadAttachment: vi.fn() },
  auth: { getSession: vi.fn() },
}));
// The real composer is the app's task composer; here its props are what matter.
vi.mock("@/components/task-chat/TaskChatComposer", () => ({
  TaskChatComposer: (props: Record<string, any>) => {
    mocks.composer = props;
    return (
      <div data-composer-stub="">
        {props.creation?.header}
        <span data-value="">{props.creation?.value}</span>
      </div>
    );
  },
}));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: mocks.chats }));
vi.mock("@/api/issues", () => ({ issuesApi: mocks.issues }));
vi.mock("@/api/auth", () => ({ authApi: mocks.auth }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string, createdAt: string, overrides: Partial<Agent> = {}) =>
  ({
    id,
    companyId: "company-1",
    name,
    urlKey: name.toLowerCase().replace(/\s+/g, "-"),
    role: "general",
    title: null,
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: {},
    createdAt: new Date(createdAt),
    ...overrides,
  }) as Agent;

const chief = agent("agent-chief", "Chief of staff", "2026-01-01T00:00:00Z");
const researcher = agent("agent-research", "Researcher", "2026-02-01T00:00:00Z");
const retired = agent("agent-old", "Old timer", "2025-01-01T00:00:00Z", { status: "terminated" });
const chat = { id: "issue-chat", companyId: "company-1", status: "in_review", updatedAt: new Date("2026-11-13T00:00:00Z") };

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render(agents: Agent[], loaded = true) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DashboardChatComposer companyId="company-1" agents={agents} loaded={loaded} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function type(text: string) {
  await act(async () => mocks.composer!.creation.onChange(text));
}

async function send() {
  const { creation } = mocks.composer!;
  await act(async () => creation.onSubmit(creation.value, "standard", null));
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.composer = null;
  mocks.auth.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.chats.ensure.mockResolvedValue(chat);
  mocks.issues.addComment.mockResolvedValue({ id: "comment-1" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe("DashboardChatComposer", () => {
  it("is the task composer with its agent picker, starting on the first agent created", async () => {
    await render([researcher, retired, chief]);
    const props = mocks.composer!;
    expect(props.enableReassign).toBe(true);
    expect(props.currentAssigneeValue).toBe("agent:agent-chief");
    expect(props.reassignOptions.map((option: { id: string }) => option.id).sort()).toEqual(["agent:agent-chief", "agent:agent-research"]);
    expect(props.modelAgents.get("agent-chief")).toBe(chief);
    expect(props.creation.submitLabel).toBe("Send");
    expect(props.workMode).toBe("standard");
  });

  it("sends: opens the chat with the chosen agent, posts the text as its first message, and goes to it", async () => {
    await render([chief, researcher]);
    await act(async () => mocks.composer!.onPendingAssigneeChange("agent:agent-research"));
    expect(mocks.composer!.currentAssigneeValue).toBe("agent:agent-research");
    await type("Draft the investor update");
    await send();
    expect(mocks.chats.ensure).toHaveBeenCalledExactlyOnceWith("company-1", "agent-research");
    expect(mocks.issues.addComment).toHaveBeenCalledExactlyOnceWith(
      "issue-chat",
      "Draft the investor update",
      undefined,
      undefined,
      [],
      expect.any(String),
    );
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/chats/researcher");
    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.composer!.creation.value).toBe("");
  });

  it("keeps the text and says what happened when it fails, and resends as the same message", async () => {
    mocks.issues.addComment.mockRejectedValueOnce(new Error("The server is unavailable"));
    await render([chief]);
    await type("Plan next week");
    await send();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t start the chat with Chief of staff.");
    expect(mocks.composer!.creation.value).toBe("Plan next week");

    await send();
    expect(mocks.issues.addComment).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.issues.addComment.mock.calls;
    expect(second![5]).toBe(first![5]);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/chats/chief-of-staff");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("resends attachments without uploading them again", async () => {
    mocks.issues.uploadAttachment.mockResolvedValueOnce({
      id: "attachment-1", contentPath: "/files/attachment-1", contentType: "text/plain", originalFilename: "notes.txt",
    });
    mocks.issues.addComment.mockRejectedValueOnce(new Error("The server is unavailable"));
    await render([chief]);
    await type("Read this");
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    await act(async () => mocks.composer!.creation.onSelectFiles([file]));
    await flush();
    await send();
    await send();
    expect(mocks.issues.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.addComment).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.issues.addComment.mock.calls;
    expect(second).toEqual(first);
    expect(second![4]).toEqual(["attachment-1"]);
  });

  it("does not pull the person back into the chat when they left before the send finished", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.issues.addComment.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render([chief]);
    await type("Plan next week");
    const { creation } = mocks.composer!;
    let sending: Promise<unknown> = Promise.resolve();
    await act(async () => { sending = Promise.resolve(creation.onSubmit("Plan next week", "standard", null)); });
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { finish({ id: "comment-1" }); await sending; await flush(); });
    expect(mocks.issues.addComment).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("saves the chosen model on the chat before the message, as the chat composer does", async () => {
    mocks.issues.getCore.mockResolvedValue({ ...chat, assigneeAdapterOverrides: null });
    mocks.issues.update.mockResolvedValue(chat);
    await render([chief]);
    await type("Go");
    const { creation } = mocks.composer!;
    await act(async () => creation.onSubmit("Go", "standard", { model: "claude-opus", effort: null, fast: false }));
    await flush();
    expect(mocks.issues.update).toHaveBeenCalledExactlyOnceWith("issue-chat", {
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus" } },
    });
    expect(mocks.issues.update.mock.invocationCallOrder[0]!).toBeLessThan(mocks.issues.addComment.mock.invocationCallOrder[0]!);
  });

  it("is one quiet line pointing to adding an agent when there are none to chat with", async () => {
    await render([retired]);
    expect(host.querySelector("[data-composer-stub]")).toBeNull();
    const line = host.querySelector<HTMLElement>('[data-dashboard-chat="no-agents"]')!;
    expect(line.textContent).toBe("Add an agent to start a chat from here.");
    expect(line.querySelector("a")?.getAttribute("href")).toBe("/agents/new");
  });

  it("shows nothing until the agents have loaded", async () => {
    await render([], false);
    expect(host.innerHTML).toBe("");
  });
});
