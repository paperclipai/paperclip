// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectWorkspace } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { ClaudeProjectTrust } from "./ClaudeProjectTrust";

vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("../api/projects", () => ({ projectsApi: { getClaudeProjectTrust: vi.fn(), setClaudeProjectTrust: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = { id: "workspace", sourceType: "local_path", cwd: "/reviewed", repoUrl: null, repoRef: null,
  defaultRef: null, remoteProvider: null, remoteWorkspaceRef: null, updatedAt: new Date("2026-11-09T10:00:00Z") } as unknown as ProjectWorkspace;

describe("Claude project trust consent", () => {
  it.each([
    { cwd: "/replacement", updatedAt: new Date("2026-11-09T10:01:00Z") },
    { repoUrl: "https://example.test/replacement.git", updatedAt: new Date("2026-11-09T10:01:00Z") },
    { updatedAt: new Date("2026-11-09T10:01:00Z") },
  ])("clears unsaved choices after the reviewed workspace changes: %j", async (changed) => {
    const empty = { agentIds: [] as string[] };
    vi.mocked(projectsApi.getClaudeProjectTrust).mockResolvedValue(empty);
    vi.mocked(projectsApi.setClaudeProjectTrust).mockResolvedValue(empty);
    vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent", name: "Claude", adapterType: "claude_local" }] as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const container = document.createElement("div"); const root = createRoot(container); document.body.appendChild(container);
    const render = (value: ProjectWorkspace) => root.render(<QueryClientProvider client={client}>
      <ClaudeProjectTrust companyId="company" projectId="project" workspace={value} disabled={false} onSaved={() => {}} />
    </QueryClientProvider>);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    try {
      await act(async () => { render(workspace); await settle(); });
      await act(async () => { await settle(); });
      const checkbox = () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
      await act(async () => { checkbox().click(); });
      expect(checkbox().getAttribute("aria-checked")).toBe("true");
      await act(async () => { render({ ...workspace, ...changed }); await settle(); });
      await act(async () => { await settle(); });
      expect(checkbox().getAttribute("aria-checked")).toBe("false");
      const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save Claude trust")!;
      await act(async () => { save.click(); await settle(); });
      expect(vi.mocked(projectsApi.setClaudeProjectTrust).mock.calls.at(-1)?.[2]).toEqual([]);
    } finally { await act(async () => root.unmount()); container.remove(); client.clear(); vi.clearAllMocks(); }
  });
  it("waits for the new source grants instead of reusing cached grants from the old source", async () => {
    let finish!: (value: { agentIds: string[] }) => void;
    vi.mocked(projectsApi.getClaudeProjectTrust).mockResolvedValueOnce({ agentIds: ["agent"] })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent", name: "Claude", adapterType: "claude_local" }] as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const container = document.createElement("div"); const root = createRoot(container); document.body.appendChild(container);
    const render = (value: ProjectWorkspace) => root.render(<QueryClientProvider client={client}>
      <ClaudeProjectTrust companyId="company" projectId="project" workspace={value} disabled={false} onSaved={() => {}} />
    </QueryClientProvider>);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    try {
      await act(async () => { render(workspace); await settle(); });
      await act(async () => { await settle(); });
      const checkbox = () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
      const save = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Save Claude trust")!;
      expect(checkbox().getAttribute("aria-checked")).toBe("true");
      await act(async () => { render({ ...workspace, cwd: "/replacement" }); await settle(); });
      expect(checkbox().getAttribute("aria-checked")).toBe("false");
      expect(save().disabled).toBe(true);
      expect(projectsApi.getClaudeProjectTrust).toHaveBeenCalledTimes(2);
      await act(async () => { finish({ agentIds: [] }); await settle(); });
      await act(async () => { await settle(); });
      expect(checkbox().getAttribute("aria-checked")).toBe("false");
      expect(save().disabled).toBe(false);
    } finally { await act(async () => root.unmount()); container.remove(); client.clear(); vi.clearAllMocks(); }
  });

});


it("offers agent identities independently of their current harness, without granting trust by default", async () => {
  vi.mocked(projectsApi.getClaudeProjectTrust).mockResolvedValue({agentIds:[]});
  vi.mocked(projectsApi.setClaudeProjectTrust).mockResolvedValue({agentIds:["pooled"]});
  vi.mocked(agentsApi.list).mockResolvedValue([{id:"direct",name:"Direct Claude",adapterType:"claude_local"},{id:"pooled",name:"Pool agent",adapterType:"paperclip_runner"},{id:"other",name:"Other harness",adapterType:"codex_local"}] as never);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
  try {
    await act(async()=>{root.render(<QueryClientProvider client={client}><ClaudeProjectTrust companyId="company" projectId="project" workspace={workspace} disabled={false} onSaved={()=>{}} /></QueryClientProvider>);await settle();});await act(async()=>{await settle();});
    expect(host.textContent).toContain("Pool agent");expect(host.textContent).toContain("Other harness");
    expect(host.textContent).toContain("independently of its current harness or pool");
    const checks=[...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];expect(checks).toHaveLength(3);
    expect(checks.every(check=>check.getAttribute("aria-checked")==="false")).toBe(true);
    await act(async()=>checks[1]!.click());
    await act(async()=>{[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="Save Claude trust")!.click();await settle();});
    expect(vi.mocked(projectsApi.setClaudeProjectTrust).mock.calls.at(-1)?.[2]).toEqual(["pooled"]);
  }finally{await act(async()=>root.unmount());client.clear();host.remove();vi.clearAllMocks();}
});


it("keeps selection lookup work linear for hundreds of agents with saved grants", async () => {
  const candidates=Array.from({length:500},(_,index)=>({id:`agent-${index}`,name:`Agent ${index}`,adapterType:index%2?"paperclip_runner":"claude_local"}));
  let selectionReads=0;
  const saved=new Proxy(candidates.slice(0,100).map(agent=>agent.id),{get(target,key,receiver){
    if(typeof key==="string" && /^\d+$/.test(key) && ++selectionReads>800) throw new Error("Repeated selection scans");
    return Reflect.get(target,key,receiver);
  }});
  vi.mocked(projectsApi.getClaudeProjectTrust).mockResolvedValue({agentIds:saved});
  vi.mocked(projectsApi.setClaudeProjectTrust).mockResolvedValue({agentIds:[]});
  vi.mocked(agentsApi.list).mockResolvedValue(candidates as never);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
  try {
    await act(async()=>{root.render(<QueryClientProvider client={client}><ClaudeProjectTrust companyId="company" projectId="project" workspace={workspace} disabled={false} onSaved={()=>{}} /></QueryClientProvider>);await settle();});await act(async()=>{await settle();});
    const checks=[...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    expect(checks).toHaveLength(500);expect(checks.filter(check=>check.getAttribute("aria-checked")==="true")).toHaveLength(100);
    await act(async()=>checks[99]!.click());await act(async()=>checks[499]!.click());
    await act(async()=>{[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="Save Claude trust")!.click();await settle();});
    const sent=vi.mocked(projectsApi.setClaudeProjectTrust).mock.calls.at(-1)?.[2];expect(sent).toHaveLength(100);expect(sent).toContain("agent-499");expect(sent).not.toContain("agent-99");expect(selectionReads).toBeLessThanOrEqual(800);
  }finally{await act(async()=>root.unmount());client.clear();host.remove();vi.clearAllMocks();}
});

it("stops new selections at the server's 100-agent limit and says so", async () => {
  const candidates=Array.from({length:150},(_,index)=>({id:`agent-${index}`,name:`Agent ${index}`,adapterType:"claude_local"}));
  vi.mocked(projectsApi.getClaudeProjectTrust).mockResolvedValue({agentIds:candidates.slice(0,99).map(agent=>agent.id)});
  vi.mocked(agentsApi.list).mockResolvedValue(candidates as never);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
  try {
    await act(async()=>{root.render(<QueryClientProvider client={client}><ClaudeProjectTrust companyId="company" projectId="project" workspace={workspace} disabled={false} onSaved={()=>{}} /></QueryClientProvider>);await settle();});await act(async()=>{await settle();});
    const checks=()=>[...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    expect(checks()[100]!.disabled).toBe(false);
    await act(async()=>checks()[99]!.click());
    expect(host.textContent).toContain("up to 100 agents per workspace (100 selected)");
    expect(checks()[100]!.disabled).toBe(true);
    expect(checks()[0]!.disabled).toBe(false);
    await act(async()=>checks()[0]!.click());
    expect(checks()[100]!.disabled).toBe(false);
  }finally{await act(async()=>root.unmount());client.clear();host.remove();vi.clearAllMocks();}
});
