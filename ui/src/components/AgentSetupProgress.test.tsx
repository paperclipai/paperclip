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

const ID = "11111111-1111-4111-8111-111111111111";
const BASE = `https://acme.paperclip.app/api/agent-setup-progress/${ID}`;
const WAITING: AgentSetupProgress = {
  id: ID, companyId: "company-1", purpose: "aws_connection", subjectId: "conn-1", status: "waiting", items: [], summary: null,
  expiresAt: "2026-11-23T20:00:00.000Z", createdAt: "2026-11-23T14:00:00.000Z", updatedAt: "2026-11-23T14:00:00.000Z",
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
    expect(container.textContent).toContain("Your agent is setting up AWS");
    expect(container.textContent).toContain("Paste the prompt into your agent.");

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
    expect(container.textContent).toContain("Last update");

    current = { ...current, status: "done", summary: "Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1",
      items: current.items.map((item) => ({ ...item, status: "done" as const })) };
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.agentSetupProgress(ID) }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("Your agent set up AWS");
    expect(container.textContent).toContain("Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1");
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
    expect(container.textContent).toContain("Your agent is setting up AWS");
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
    expect(container.textContent).toContain("This setup prompt expired");
    const startAgain = [...container.querySelectorAll("button")].find((b) => b.textContent === "Start again")!;
    await act(async () => { startAgain.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(create).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="token"]')?.textContent).toBe("pcsp_fresh");
    expect(container.textContent).toContain("Paste the prompt into your agent.");
  });
});
