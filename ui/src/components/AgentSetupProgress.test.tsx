// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSetupProgress, AgentSetupProgressHandoff } from "@paperclipai/shared";
import {
  AgentSetupProgressPanel,
  agentSetupProgressInstructions,
  useAgentSetupProgress,
  type AgentSetupProgressClient,
} from "./AgentSetupProgress";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/api/agentSetupProgress", () => ({ agentSetupProgressApi: {} }));
const account = vi.hoisted(() => ({ userId: "user-1" as string | null, settled: true, current: true, failed: false }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: account.userId, settled: account.settled, current: account.settled && account.current, failed: account.failed }) }));

const ID = "11111111-1111-4111-8111-111111111111";
const BASE = `https://acme.paperclip.app/api/agent-setup-progress/${ID}`;
const WAITING: AgentSetupProgress = {
  id: ID, companyId: "company-1", purpose: "aws_connection", subjectId: "conn-1", status: "waiting", items: [], summary: null,
  expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(), createdAt: "2026-11-23T14:00:00.000Z", updatedAt: "2026-11-23T14:00:00.000Z",
};
const HANDOFF: AgentSetupProgressHandoff = {
  progress: WAITING, token: "pcsp_token", urls: { checklist: `${BASE}/checklist`, item: `${BASE}/items/{key}`, finish: `${BASE}/finish` },
};

describe("agent setup progress", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    window.sessionStorage.clear();
    account.userId = "user-1";
    account.settled = true;
    account.current = true;
    account.failed = false;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("tells the agent exactly how to set, update and finish its checklist", () => {
    const text = agentSetupProgressInstructions(HANDOFF, [{ key: "check-account", title: "Check the AWS account" }]);
    expect(text).toContain(`curl -sS -X PUT ${BASE}/checklist -H "Authorization: Bearer pcsp_token"`);
    expect(text).toContain(`'{"items":[{"key":"check-account","title":"Check the AWS account"}]}'`);
    expect(text).toContain(`${BASE}/items/check-account`);
    expect(text).toContain(`${BASE}/finish`);
    expect(text).toContain("If one fails, keep going with the setup.");
  });

  function Harness({ client }: { client: AgentSetupProgressClient }) {
    const { progress, handoff } = useAgentSetupProgress({ companyId: "company-1", purpose: "aws_connection", subjectId: "conn-1", client });
    return handoff ? <AgentSetupProgressPanel progress={progress} subject="AWS" /> : <p>creating</p>;
  }

  it("creates one checklist, waits for the agent, then shows each update live and the finish", async () => {
    let current: AgentSetupProgress = WAITING;
    const client: AgentSetupProgressClient = { create: vi.fn(async () => HANDOFF), get: vi.fn(async () => current) };
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness client={client} /></QueryClientProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.create).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent is setting up AWS"));
    await vi.waitFor(() => expect(container.textContent).toContain("Paste the prompt into your agent."));

    current = { ...WAITING, status: "in_progress", updatedAt: new Date().toISOString(), items: [
      { key: "check-account", title: "Check the AWS account", status: "done", detail: "Account 123456789012" },
      { key: "deploy-stack", title: "Create the role", status: "in_progress", detail: null },
      { key: "report-role", title: "Report the role ARN", status: "pending", detail: null },
    ] };
    // What the live event does when the agent sends an update.
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.agentSetupProgress(ID) }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const rows = [...container.querySelectorAll("li")].map((li) => [
      li.getAttribute("data-status"), [...li.querySelectorAll("p")].map((p) => p.textContent).join(" | "), li.lastElementChild?.textContent,
    ].join(" · "));
    expect(rows).toEqual([
      "done · Check the AWS account | Account 123456789012 · Done",
      "in_progress · Create the role · In progress",
      "pending · Report the role ARN · Not started",
    ]);
    await vi.waitFor(() => expect(container.textContent).toContain("Last update"));

    current = { ...current, status: "done", summary: "Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1",
      items: current.items.map((item) => ({ ...item, status: "done" as const })) };
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.agentSetupProgress(ID) }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent set up AWS"));
    await vi.waitFor(() => expect(container.textContent).toContain("Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1"));
    expect(client.create).toHaveBeenCalledOnce();
  });

  it("keeps following the same checklist after leaving the step and coming back", async () => {
    const client: AgentSetupProgressClient = { create: vi.fn(async () => HANDOFF), get: vi.fn(async () => WAITING) };
    const show = (visible: boolean) => root.render(
      <QueryClientProvider client={queryClient}>{visible ? <Harness client={client} /> : <p>other step</p>}</QueryClientProvider>,
    );
    await act(async () => { show(true); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { show(false); });
    await act(async () => { show(true); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The copied prompt writes to the first checklist, so coming back must not make another.
    expect(client.create).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent is setting up AWS"));
  });

  it("says when the prompt expired and starts again with a fresh checklist", async () => {
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    const stale: AgentSetupProgress = { ...WAITING, status: "in_progress", expiresAt: expiredAt,
      items: [{ key: "check-account", title: "Check the AWS account", status: "in_progress", detail: null }] };
    const fresh: AgentSetupProgressHandoff = { ...HANDOFF, token: "pcsp_fresh", progress: { ...WAITING, id: "22222222-2222-4222-8222-222222222222" } };
    const create = vi.fn().mockResolvedValueOnce({ ...HANDOFF, progress: stale }).mockResolvedValueOnce(fresh);
    const client: AgentSetupProgressClient = { create, get: vi.fn(async (id: string) => id === fresh.progress.id ? fresh.progress : stale) };
    function Renewing() {
      const state = useAgentSetupProgress({ companyId: "company-1", purpose: "aws_connection", subjectId: "conn-1", client });
      return state.handoff ? (
        <>
          <span data-testid="token">{state.handoff.token}</span>
          <AgentSetupProgressPanel progress={state.progress} subject="AWS" expired={state.expired} onRenew={state.renew} />
        </>
      ) : null;
    }
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><Renewing /></QueryClientProvider>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await vi.waitFor(() => expect(container.textContent).toContain("This setup prompt expired"));
    const startAgain = [...container.querySelectorAll("button")].find((b) => b.textContent === "Start again")!;
    await act(async () => { startAgain.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(create).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="token"]')?.textContent).toBe("pcsp_fresh");
    await vi.waitFor(() => expect(container.textContent).toContain("Paste the prompt into your agent."));
  });

  it("keeps following the same checklist after the page reloads", async () => {
    const client: AgentSetupProgressClient = { create: vi.fn(async () => HANDOFF), get: vi.fn(async () => WAITING) };
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><Harness client={client} /></QueryClientProvider>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => root.unmount());
    // A reload starts with an empty query cache; this tab still has the handoff the copied prompt uses.
    root = createRoot(container);
    const reloaded = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={reloaded}><Harness client={client} /></QueryClientProvider>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.create).toHaveBeenCalledOnce();
    expect(client.get).toHaveBeenCalledWith(ID);
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent is setting up AWS"));
  });

  function Full({ client }: { client: AgentSetupProgressClient }) {
    const state = useAgentSetupProgress({ companyId: "company-1", purpose: "aws_connection", subjectId: "conn-1", client });
    return state.handoff ? (
      <>
        <span data-testid="token">{state.handoff.token}</span>
        <AgentSetupProgressPanel progress={state.progress} subject="AWS" expired={state.expired} onRenew={state.renew}
          refreshError={state.refreshError} onRetryRefresh={state.retryRefresh} />
      </>
    ) : null;
  }
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const token = () => container.querySelector('[data-testid="token"]')?.textContent;

  it("offers a fresh checklist after a failed attempt, and opening the step again later starts fresh", async () => {
    const failedAttempt: AgentSetupProgress = { ...WAITING, status: "failed", summary: "Stopped: no permission",
      items: [{ key: "deploy", title: "Create the role", status: "failed", detail: "iam:CreateRole denied" }] };
    const second: AgentSetupProgressHandoff = { ...HANDOFF, token: "pcsp_second", progress: { ...WAITING, id: "33333333-3333-4333-8333-333333333333" } };
    const create = vi.fn().mockResolvedValueOnce(HANDOFF).mockResolvedValueOnce(second);
    const client: AgentSetupProgressClient = { create, get: vi.fn(async (id: string) => id === ID ? failedAttempt : second.progress) };
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><Full client={client} /></QueryClientProvider>); });
    await flush();
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.agentSetupProgress(ID) }); });
    await flush();
    // The failed attempt stays on screen while this page is open, with a way to try again.
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent couldn’t finish setting up AWS"));
    expect(window.sessionStorage.length).toBe(0);
    const startAgain = [...container.querySelectorAll("button")].find((b) => b.textContent === "Start again")!;
    await act(async () => { startAgain.click(); });
    await flush();
    await vi.waitFor(() => expect(token()).toBe("pcsp_second"));

    // Opening the step again with a finished checklist in the cache (such as a reconnect) starts a fresh one.
    const third: AgentSetupProgressHandoff = { ...HANDOFF, token: "pcsp_third", progress: { ...WAITING, id: "44444444-4444-4444-8444-444444444444" } };
    const reopenCreate = vi.fn().mockResolvedValueOnce(third);
    const finishedCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    finishedCache.setQueryData(["agent-setup-progress-handoff", "user-1", "company-1", "aws_connection", "conn-1"], { handoff: HANDOFF, fromEarlierVisit: false });
    // Cached before this step opens, like a checklist from an earlier visit in this session.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const reopenClient: AgentSetupProgressClient = { create: reopenCreate, get: vi.fn(async (id: string) => id === ID ? { ...failedAttempt, status: "done" as const } : third.progress) };
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => { root.render(<QueryClientProvider client={finishedCache}><Full client={reopenClient} /></QueryClientProvider>); });
    await flush();
    await flush();
    expect(reopenCreate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(token()).toBe("pcsp_third"));
  });

  it("keeps the last checklist when a refresh fails, says so, and retries", async () => {
    const working: AgentSetupProgress = { ...WAITING, status: "in_progress",
      items: [{ key: "deploy", title: "Create the role", status: "in_progress", detail: null }] };
    const get = vi.fn().mockResolvedValueOnce(working).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(working);
    const client: AgentSetupProgressClient = { create: vi.fn(async () => HANDOFF), get };
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><Full client={client} /></QueryClientProvider>); });
    await flush();
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.agentSetupProgress(ID) }); });
    await flush();
    await vi.waitFor(() => expect(container.textContent).toContain("Create the role"));
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn’t refresh your agent’s progress"));
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => { retry.click(); });
    await flush();
    expect(container.textContent).not.toContain("Couldn’t refresh your agent’s progress");
  });

  it("never hands one account's checklist to another account in the same tab", async () => {
    const second: AgentSetupProgressHandoff = { ...HANDOFF, token: "pcsp_other_account", progress: { ...WAITING, id: "55555555-5555-4555-8555-555555555555" } };
    const create = vi.fn().mockResolvedValueOnce(HANDOFF).mockResolvedValueOnce(second);
    const client: AgentSetupProgressClient = { create, get: vi.fn(async (id: string) => id === ID ? WAITING : second.progress) };
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><Full client={client} /></QueryClientProvider>); });
    await flush();
    await vi.waitFor(() => expect(token()).toBe("pcsp_token"));
    // Signed out in another tab (this tab's storage stays), then another account opens the same setup here.
    await act(async () => root.unmount());
    account.userId = "user-2";
    root = createRoot(container);
    const freshCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={freshCache}><Full client={client} /></QueryClientProvider>); });
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(token()).toBe("pcsp_other_account"));
  });

  it("does not read the previous account's checklist while a sign-in's session refresh is in flight", async () => {
    // The previous account left a checklist in this tab; the session still names it, but was just invalidated.
    window.sessionStorage.setItem("paperclip:agent-setup-progress:user-1:company-1:aws_connection:conn-1", JSON.stringify(HANDOFF));
    const fresh: AgentSetupProgressHandoff = { ...HANDOFF, token: "pcsp_new_account", progress: { ...WAITING, id: "77777777-7777-4777-8777-777777777777" } };
    const create = vi.fn().mockResolvedValueOnce(fresh);
    const client: AgentSetupProgressClient = { create, get: vi.fn(async () => fresh.progress) };
    account.current = false;
    const tree = () => <QueryClientProvider client={queryClient}><Full client={client} /></QueryClientProvider>;
    await act(async () => { root.render(tree()); });
    await flush();
    expect(token()).not.toBe("pcsp_token");
    expect(client.get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    // The refresh lands with the new account: it gets its own checklist.
    account.userId = "user-2";
    account.current = true;
    await act(async () => { root.render(tree()); });
    await vi.waitFor(() => expect(token()).toBe("pcsp_new_account"));
    expect(create).toHaveBeenCalledOnce();
  });

  it("replaces a finished checklist from an earlier visit even when the session arrives late", async () => {
    // A previous visit in this tab stored a checklist that has since finished.
    window.sessionStorage.setItem("paperclip:agent-setup-progress:user-1:company-1:aws_connection:conn-1", JSON.stringify(HANDOFF));
    const fresh: AgentSetupProgressHandoff = { ...HANDOFF, token: "pcsp_fresh_visit", progress: { ...WAITING, id: "66666666-6666-4666-8666-666666666666" } };
    const create = vi.fn().mockResolvedValueOnce(fresh);
    const client: AgentSetupProgressClient = { create, get: vi.fn(async (id: string) => id === ID ? { ...WAITING, status: "done" as const } : fresh.progress) };
    account.userId = null;
    account.settled = false;
    const tree = () => <QueryClientProvider client={queryClient}><Full client={client} /></QueryClientProvider>;
    await act(async () => { root.render(tree()); });
    await flush();
    expect(create).not.toHaveBeenCalled();
    account.userId = "user-1";
    account.settled = true;
    await act(async () => { root.render(tree()); });
    await vi.waitFor(() => expect(token()).toBe("pcsp_fresh_visit"));
    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps the agent's text out of session recordings", async () => {
    const done: AgentSetupProgress = { ...WAITING, status: "done", summary: "Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1",
      items: [{ key: "check-account", title: "Check the AWS account", status: "done", detail: "Account 123456789012" }] };
    await act(async () => { root.render(<AgentSetupProgressPanel progress={done} subject="AWS" />); });
    const summary = [...container.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Role ARN"))!;
    expect(summary.closest(".ph-mask")).not.toBeNull();
    expect(container.querySelector("ol")?.classList.contains("ph-mask")).toBe(true);
  });

  it("says when the sign-in lookup failed instead of waiting forever, and retries it", async () => {
    account.userId = null;
    account.settled = false;
    account.failed = true;
    const client: AgentSetupProgressClient = { create: vi.fn(async () => HANDOFF), get: vi.fn(async () => WAITING) };
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let state: ReturnType<typeof useAgentSetupProgress> | null = null;
    function Probe() {
      state = useAgentSetupProgress({ companyId: "company-1", purpose: "aws_connection", subjectId: "conn-1", client });
      return null;
    }
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });
    await flush();
    expect(client.create).not.toHaveBeenCalled();
    expect(state!.error).toBe("Paperclip couldn’t confirm who is signed in.");
    await act(async () => { state!.renew(); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["auth", "session"] });
  });
});
