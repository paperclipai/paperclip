// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GoogleWorkspaceServiceSelection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceServicesDialog } from "./GoogleWorkspaceServices";

vi.mock("@/api/tools", () => ({ toolsApi: { listConnectionGrants: vi.fn() } }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

const removedText = [
  "What agents can do",
  "How your data is used",
  "agents can read and search your email",
  "agents can read and search your files",
  "agents can see your calendars",
  "Paperclip does not send email",
  "Agents read this content only to do the tasks you give them.",
  "sent to the AI model provider configured for your workspace",
  "It is not used to train general AI models.",
  "Results are saved in the task and its run history",
];

describe("Google Workspace service picker", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onContinue = vi.fn();

  async function render(initial?: GoogleWorkspaceServiceSelection) {
    await act(async () => { root.render(<QueryClientProvider client={client}>
      <GoogleWorkspaceServicesDialog initial={initial} onContinue={onContinue} onCancel={vi.fn()} />
    </QueryClientProvider>); });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient();
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    client.clear();
    container.remove();
  });

  it.each<[string, GoogleWorkspaceServiceSelection | undefined]>([
    ["all services with read & write", undefined],
    ["all services read only", { gmail: "read", drive: "read", calendar: "read" }],
    ["a single service", { calendar: "write" }],
    ["no services", {}],
  ])("shows only the service rows and the privacy policy link for %s", async (_label, initial) => {
    await render(initial);
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const text of removedText) expect(dialog.textContent).not.toContain(text);
    expect(dialog.querySelector("h3")).toBeNull();
    expect(dialog.querySelector("ul")).toBeNull();
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(3);
    const link = [...dialog.querySelectorAll("a")].find(item => item.textContent?.includes("Limited Use"))!;
    expect(link.textContent).toBe("Read our privacy policy, including how we meet Google's Limited Use requirements (opens in a new tab)");
    expect(link.getAttribute("href")).toBe("https://paperclip.ing/privacy");
    expect(link.getAttribute("target")).toBe("_blank");
    const description = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Choose the Google services to connect.");
  });

  it("keeps Continue disabled with no services and submits the chosen services", async () => {
    await render({});
    const disabled = [...document.querySelectorAll("button")].find(item => item.textContent === "Continue")!;
    expect(disabled.disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Select at least one service to continue.");
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render({ gmail: "read" });
    await act(async () => { [...document.querySelectorAll("button")].find(item => item.textContent === "Continue")!.click(); });
    expect(onContinue).toHaveBeenCalledWith({ gmail: "read" });
  });
});
