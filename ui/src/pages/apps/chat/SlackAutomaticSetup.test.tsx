// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { SlackAutomaticSetup } from "./SlackAutomaticSetup";

const api = vi.hoisted(() => ({ createSlackApp: vi.fn(), installSlackApp: vi.fn(), get: vi.fn(), resumeSlackInstallation: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: api }));

const draft = { id: "endpoint-a", setup: { slackSetupMethod: "automatic" } } as ChatEndpoint;
const created = { ...draft, setup: { ...draft.setup, slackRegistration: { status: "install", appId: "ATEST" } } } as ChatEndpoint;

describe("automatic Slack installation handoff", () => {
  let root: Root;
  let container: HTMLDivElement;
  let popup: { opener: unknown; closed: boolean; document: { title: string; body: { textContent: string } }; location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> };
  const onSaved = vi.fn();
  const onContinue = vi.fn();
  beforeEach(async () => {
    vi.resetAllMocks();
    popup = { opener: window, closed: false, document: { title: "", body: { textContent: "" } }, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    api.createSlackApp.mockResolvedValue(created);
    api.installSlackApp.mockResolvedValue({ authorizationUrl: "https://slack.com/oauth/v2/authorize?state=fixture" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<SlackAutomaticSetup endpoint={draft} stage="app" disabled={false}
      saveDetails={async () => {}} onSaved={onSaved} onContinue={onContinue} onBusy={() => {}}
      onManual={async () => {}} onSaveExit={() => {}} />));
    await act(async () => {
      const input = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-config-token");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  async function submit() {
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Create Slack app")!.click());
  }
  it("opens a window during the click and navigates it only after saved creation and authorization", async () => {
    let resolve!: (value: ChatEndpoint) => void;
    api.createSlackApp.mockReturnValue(new Promise<ChatEndpoint>(done => { resolve = done; }));
    await submit();
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(popup.opener).toBeNull();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(api.installSlackApp).not.toHaveBeenCalled();
    expect(container.querySelector("input")!.value).toBe("");
    await act(async () => resolve(created));
    expect(onSaved).toHaveBeenCalledWith(created);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(api.installSlackApp).toHaveBeenCalledExactlyOnceWith(draft.id);
    expect(popup.location.replace).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?state=fixture");
    expect(popup.close).not.toHaveBeenCalled();
  });
  it("keeps the saved app and offers installation when the popup is blocked", async () => {
    vi.mocked(window.open).mockReturnValue(null);
    await submit();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(api.installSlackApp).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Select Install in Slack");
  });
  it("closes the placeholder and keeps installation retryable when authorization fails", async () => {
    api.installSlackApp.mockRejectedValue(new Error("Installation unavailable"));
    await submit();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(api.createSlackApp).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it.each(["uncertain", "pending configuration"])("does not install on %s creation", async status => {
    const saved = status === "uncertain"
      ? { ...draft, setup: { ...draft.setup, slackRegistration: { status: "uncertain" } } }
      : { ...created, setup: { ...created.setup, slackRegistration: { ...created.setup!.slackRegistration, errorCode: "slack_manifest_update_pending" } } };
    api.createSlackApp.mockResolvedValue(saved);
    await submit();
    expect(api.installSlackApp).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost creation response using saved state without creating another app", async () => {
    api.createSlackApp.mockRejectedValue(new Error("Lost response"));
    api.get.mockResolvedValue(created);
    await submit();
    expect(api.createSlackApp).toHaveBeenCalledTimes(1);
    expect(api.installSlackApp).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
  it("closes the waiting window and does not install after leaving setup", async () => {
    let resolve!: (value: ChatEndpoint) => void;
    api.createSlackApp.mockReturnValue(new Promise<ChatEndpoint>(done => { resolve = done; }));
    await submit();
    await act(async () => root.unmount());
    await act(async () => resolve(created));
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(api.installSlackApp).not.toHaveBeenCalled();
  });
});

describe("automatic Slack setup actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const endpoint: ChatEndpoint = { id: "endpoint", companyId: "company", provider: "slack", status: "draft", assignedAgentId: "agent", assignedAgentName: "Maya", allowUnlinkedPeople: false, setup: { step: "provider_setup", slackSetupMethod: "automatic" } };
  const saved: ChatEndpoint = { ...endpoint, setup: { ...endpoint.setup!, slackRegistration: { status: "install", appId: "AEXAMPLE" } } };
  const onSaved = vi.fn(), onContinue = vi.fn(), onManual = vi.fn(), saveDetails = vi.fn(), onBusy = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, "open").mockReturnValue(null);
    localStorage.clear(); sessionStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    api.createSlackApp.mockResolvedValue(saved); api.get.mockResolvedValue(endpoint); saveDetails.mockResolvedValue(undefined);
  });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  function render(value = endpoint, stage: "app" | "credentials" = "app") {
    flushSync(() => root.render(<SlackAutomaticSetup endpoint={value} stage={stage} disabled={false} saveDetails={saveDetails}
      onSaved={onSaved} onContinue={onContinue} onManual={onManual} onBusy={onBusy} onSaveExit={() => {}} />));
  }
  function enter(value: string) {
    const field = container.querySelector("input[type=password]")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!;
    expect(button).toBeDefined(); flushSync(() => button.click());
  }
  it("clears the token, prevents duplicate clicks, and advances only from saved app identity", async () => {
    let complete!: (value: ChatEndpoint) => void;
    api.createSlackApp.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(container.querySelector<HTMLInputElement>("input[type=password]")!.value).toBe("");
    click("Create Slack app"); expect(api.createSlackApp).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    complete(saved); await settle();
    expect(onContinue).toHaveBeenCalledTimes(1); expect(onSaved).toHaveBeenCalledWith(saved);
    expect(saveDetails.mock.invocationCallOrder[0]).toBeLessThan(api.createSlackApp.mock.invocationCallOrder[0]);
    expect(container.innerHTML).not.toContain("configuration-canary");
  });
  it("recovers a lost response by reading saved state without another creation request", async () => {
    api.createSlackApp.mockRejectedValue(new Error("lost response")); api.get.mockResolvedValue(saved);
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(api.createSlackApp).toHaveBeenCalledTimes(1); expect(onContinue).toHaveBeenCalledTimes(1);
  });
  it("redacts error echoes and clears the token when creation fails", async () => {
    api.createSlackApp.mockRejectedValue(new Error("Provider echoed configuration-canary"));
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(container.textContent).toContain("[redacted]"); expect(container.innerHTML).not.toContain("configuration-canary");
    expect(onContinue).not.toHaveBeenCalled();
  });
  it("requires an explicit checked-no-app confirmation before retrying an uncertain result", async () => {
    render({ ...endpoint, setup: { ...endpoint.setup!, slackRegistration: { status: "uncertain", errorCode: "slack_creation_uncertain" } } });
    expect(container.querySelector("input[type=password]")).toBeNull();
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    enter("new-token"); click("Create Slack app"); await settle();
    expect(api.createSlackApp.mock.calls[0][1]).toMatchObject({ confirmedNoAppCreated: true });
  });
  it("keeps both manual paths explicit and resumes saved installation credentials", async () => {
    render(); click("Use an existing app"); await settle(); expect(onManual).toHaveBeenCalledWith(true);
    render({ ...saved, setup: { ...saved.setup!, slackRegistration: { status: "credentials_saved", appId: "AEXAMPLE" } } }, "credentials");
    api.resumeSlackInstallation.mockResolvedValue(saved);
    click("Retry connecting"); await settle();
    expect(api.resumeSlackInstallation).toHaveBeenCalledWith("endpoint"); expect(api.createSlackApp).not.toHaveBeenCalled();
    api.installSlackApp.mockRejectedValue(new Error("Authorization unavailable"));
    click("Authorize in Slack again"); await settle();
    expect(api.installSlackApp).toHaveBeenCalledWith("endpoint");
    expect(api.createSlackApp).not.toHaveBeenCalled();
  });
});
