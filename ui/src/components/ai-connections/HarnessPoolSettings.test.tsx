// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HarnessPoolSettings } from "./HarnessPoolSettings";
const mocks = vi.hoisted(() => ({ pools: vi.fn(), accounts: vi.fn(), save: vi.fn(), legacy: vi.fn(), inspect: vi.fn(), convert: vi.fn(), archive: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { adapterModels: async () => [{ id: "smart-a", label: "Smart A" }, { id: "smart-b", label: "Smart B" }] } }));
vi.mock("@/adapters/use-disabled-adapters", () => ({ useDisabledAdaptersSync: () => new Set<string>() }));
vi.mock("@/api/harness-pools", () => ({ harnessPoolsApi: { list: mocks.pools, save: mocks.save, inspect: mocks.inspect, convert: mocks.convert, archive: mocks.archive } }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: mocks.accounts } }));
vi.mock("@/api/ai-connection-pools", () => ({ aiConnectionPoolsApi: { list: mocks.legacy } }));
afterEach(() => vi.clearAllMocks());
async function settle() { for(let i=0;i<8;i++) { await new Promise(resolve=>setTimeout(resolve,0)); flushSync(()=>{}); } }

it("places icon reorder actions beside the member name and removal in its footer", async () => {
  const members = [crypto.randomUUID(), crypto.randomUUID()].map(id => ({ id, harness: { type: "codex" }, runner: "legacy", adapterConfig: { engine: "cli" }, model: "smart-a" }));
  const pool = { id: crypto.randomUUID(), companyId: "company", revision: 2, name: "Actions", schemaVersion: 2, kind: "harness_pool", enabled: true, mode: "failover", members };
  mocks.pools.mockResolvedValue([pool]); mocks.legacy.mockResolvedValue([]);
  mocks.accounts.mockResolvedValue({ canManageConnections: true, connections: [] });
  mocks.inspect.mockResolvedValue({ members: {}, usedBy: [] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>)); await settle();
    flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="Actions · 2 members"]')!.click()); await settle();
    const cards = () => [...host.querySelectorAll<HTMLElement>('section[data-pool-member]')];
    const first = cards()[0]!;
    const header = first.querySelector("header")!;
    expect(header.querySelector("h3")?.textContent).toBe("Member 1");
    const up = header.querySelector<HTMLButtonElement>('[aria-label="Move up"]')!;
    const down = header.querySelector<HTMLButtonElement>('[aria-label="Move down"]')!;
    expect(up.disabled).toBe(true); expect(down.disabled).toBe(false);
    expect(up.textContent).toBe(""); expect(down.textContent).toBe("");
    expect(up.querySelector("svg")).toBeTruthy(); expect(down.querySelector("svg")).toBeTruthy();
    flushSync(() => down.click());
    expect(cards().map(card => card.dataset.poolMember)).toEqual([members[1]!.id, members[0]!.id]);
    const remove = cards()[0]!.querySelector<HTMLButtonElement>("footer button")!;
    expect(remove.textContent).toBe("Remove member"); expect(remove.classList).toContain("text-destructive");
    flushSync(() => remove.click());
    expect(cards().map(card => card.dataset.poolMember)).toEqual([members[0]!.id]);
    expect(mocks.save).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); client.clear(); host.remove(); }
});
it("creates a named pool with ordered models on the same account and leaves other pools intact", async () => {
  const account = { id: crypto.randomUUID(), grantId: crypto.randomUUID(), companyId: "company", status: "connected", name: "Shared Codex", ownership: "shared", provider: "openai", method: "api_key" };
  mocks.pools.mockResolvedValue([]); mocks.legacy.mockResolvedValue([]); mocks.inspect.mockResolvedValue({ members: {}, usedBy: [] });
  mocks.accounts.mockResolvedValue({ canManageConnections:true, connections:[account] });
  mocks.save.mockImplementation(async (_company, body) => ({ ...body.config, id:crypto.randomUUID(), companyId:"company", revision:1 }));
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try {
  flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>)); await settle();
  const click=(text:string)=>{ const button=Array.from(host.querySelectorAll("button")).find(item=>item.textContent===text || item.getAttribute("aria-label")===text)!; expect(button).toBeTruthy(); flushSync(()=>button.click()); };
  click("Add pool");
  const name = host.querySelector<HTMLInputElement>('[aria-label="Pool name"]')!;
  flushSync(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "My pool"); name.dispatchEvent(new Event("input", { bubbles: true })); });
  click("Add member"); click("Add member");
  await settle();
  for (let index = 0; index < 2; index++) {
    const trigger = host.querySelectorAll<HTMLElement>('[aria-label="Connection"]')[index]!;
    flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.textContent?.includes("Shared Codex"))!;
    expect(option).toBeTruthy(); flushSync(() => option.click()); await settle();
    const member = host.querySelectorAll('fieldset')[index]!;
    flushSync(() => member.querySelector<HTMLButtonElement>('[aria-label="Model"]')!.click()); await settle();
    const modelOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.textContent === (index === 0 ? "Smart A" : "Smart B"))!;
    expect(modelOption).toBeTruthy(); flushSync(() => modelOption.click()); await settle();
  }
  click("Save pool"); await settle();
  expect(mocks.save).toHaveBeenCalledWith("company",expect.objectContaining({ config:expect.objectContaining({name:"My pool",schemaVersion:2,members:[expect.objectContaining({model:"smart-a",connection:expect.objectContaining({connectionId:account.id})}),expect.objectContaining({model:"smart-b",connection:expect.objectContaining({connectionId:account.id})})]}) }));
  } finally { flushSync(()=>root.unmount()); client.clear();host.remove(); }
}, 30_000);

it("starts unselected and opens an empty custom draft without templates or writes", async () => {
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]});mocks.pools.mockResolvedValue([{id:"existing",name:"Smart",schemaVersion:2,kind:"harness_pool",enabled:true,mode:"failover",revision:3,members:[]}]);mocks.legacy.mockResolvedValue([]);
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try {
    flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>));await settle();
    expect(host.querySelector('[aria-label="Pool name"]')).toBeNull();
    expect(host.querySelector('[aria-label="Pools"]')).toBeTruthy();
    expect(host.textContent).not.toContain("Cheap"); expect(host.textContent).not.toContain("Mid");
    flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.getAttribute("aria-label")==="Add pool")!.click());
    expect(host.querySelector<HTMLInputElement>('[aria-label="Pool name"]')!.value).toBe("");expect(mocks.save).not.toHaveBeenCalled();
  } finally {flushSync(()=>root.unmount());client.clear();host.remove();}
});

it("can add the first member before any accounts are connected", async () => {
  mocks.accounts.mockResolvedValue({ canManageConnections: true, connections: [] });
  mocks.pools.mockResolvedValue([]); mocks.legacy.mockResolvedValue([]);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>)); await settle();
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === "Add pool")!.click());
    const add = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Add member")!;
    expect(add.disabled).toBe(false); flushSync(() => add.click()); await settle();
    expect(host.querySelector('[aria-label="Harness"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Connection"]')).toBeTruthy();
    expect(mocks.save).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); client.clear(); host.remove(); }
});
it("does not load or disclose managed pool members without management permission", async()=>{
  mocks.accounts.mockResolvedValue({canManageConnections:false,connections:[]});mocks.pools.mockResolvedValue([{name:"Private pool"}]);
  const host=document.createElement("div");const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>));await settle();expect(mocks.pools).not.toHaveBeenCalled();expect(host.textContent).toContain("permission is required");expect(host.textContent).not.toContain("Private pool");}
  finally{flushSync(()=>root.unmount());client.clear();}
});
it("requires an explicit confirmation after conversion preview", async()=>{
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]});mocks.pools.mockResolvedValue([]);mocks.legacy.mockResolvedValue([{id:"old",name:"Old pool",revision:4,pluginKey:"paperclip.builtin.ordered-failover",mode:"failover"}]);
  mocks.convert.mockResolvedValue({id:"old",name:"Old pool",revision:4,members:[]});
  const host=document.createElement("div");const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>));await settle();flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Preview conversion: Old pool")!.click());await settle();expect(mocks.convert).toHaveBeenCalledWith("company","old",4,true);expect(mocks.convert).toHaveBeenCalledTimes(1);flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Convert pool")!.click());await settle();expect(mocks.convert).toHaveBeenCalledWith("company","old",4,false);}
  finally{flushSync(()=>root.unmount());client.clear();}
});

it.each(["loading", "error"])("blocks archive when affected-agent inspection is %s", async state => {
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]});mocks.legacy.mockResolvedValue([]);
  mocks.pools.mockResolvedValue([{id:"used-pool",name:"Used pool",revision:1,schemaVersion:2,kind:"harness_pool",enabled:true,mode:"failover",members:[]}]);
  if(state==="loading") mocks.inspect.mockImplementation(()=>new Promise(()=>{}));else mocks.inspect.mockRejectedValue(new Error("Inspection unavailable"));
  const host=document.createElement("div");const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>));await settle();flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.getAttribute("aria-label")?.startsWith("Used pool ·"))!.click());await settle();expect(host.textContent).not.toContain("No agents");expect(Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Archive pool")!.disabled).toBe(true);expect(mocks.archive).not.toHaveBeenCalled();}
  finally{flushSync(()=>root.unmount());client.clear();}
});

it("retains cached affected agents after an inspection refresh fails while blocking archive", async () => {
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]}); mocks.legacy.mockResolvedValue([]);
  mocks.pools.mockResolvedValue([{id:"used-pool",name:"Used pool",revision:1,schemaVersion:2,kind:"harness_pool",enabled:true,mode:"failover",members:[]}]);
  mocks.inspect.mockRejectedValue(new Error("Inspection unavailable"));
  const host=document.createElement("div"); const root=createRoot(host); const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  client.setQueryData(["harness-pool-inspection","company","used-pool"], { members:{},usedBy:[{id:"agent",name:"Morgan"}] });
  try {
    flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>)); await settle();
    flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.getAttribute("aria-label")?.startsWith("Used pool ·"))!.click()); await settle();
    expect(host.textContent).toContain("Used by: Morgan");
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
    expect(Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Archive pool")!.disabled).toBe(true);
    expect(mocks.archive).not.toHaveBeenCalled();
  } finally { flushSync(()=>root.unmount()); client.clear(); host.remove(); }
});

it("edits an existing pool with its revision and preserves member runtime settings", async () => {
  const id=crypto.randomUUID(), memberId=crypto.randomUUID(), connectionId=crypto.randomUUID(), grantId=crypto.randomUUID();
  const config={schemaVersion:2,kind:"harness_pool",name:"Existing pool",enabled:true,mode:"failover",members:[{id:memberId,harness:{type:"claude_code"},runner:"legacy",adapterConfig:{engine:"cli",chrome:true},connection:{mode:"shared",connectionId,grantId,provider:"anthropic",method:"api_key"},model:"claude-sonnet"}]};
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]});mocks.legacy.mockResolvedValue([]);
  mocks.pools.mockResolvedValue([{...config,id,companyId:"company",revision:7}]);mocks.inspect.mockResolvedValue({members:{},usedBy:[]});
  mocks.save.mockResolvedValue({...config,id,companyId:"company",revision:8});
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try {
    flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>)); await settle();
    expect(host.querySelector('[aria-label="Pool name"]')).toBeNull();
    flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.getAttribute("aria-label")?.startsWith("Existing pool ·"))!.click());await settle();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Pool name"]')!.value).toBe("Existing pool");
    expect(host.querySelector('[aria-label="Runner"]')?.textContent).toContain("Legacy");
    flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Save pool")!.click());await settle();
    expect(mocks.save).toHaveBeenCalledWith("company",{id,expectedRevision:7,config});
  } finally {flushSync(()=>root.unmount());client.clear();host.remove();}
});

it("searches the pool sidebar, clears no matches and opens blank creation from its icon action", async () => {
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]});mocks.legacy.mockResolvedValue([]);mocks.inspect.mockResolvedValue({members:{},usedBy:[]});
  mocks.pools.mockResolvedValue(["Engineering", "Design"].map((name,index)=>({id:`pool-${index}`,name,revision:1,schemaVersion:2,kind:"harness_pool",enabled:true,mode:"failover",members:[]})));
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const button=(label:string)=>host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>));await settle();
    const sidebar=host.querySelector('aside[aria-label="Pools"]')!;
    expect(sidebar).toBeTruthy();
    expect(sidebar.classList).toContain("md:border-r");
    expect(host.querySelector('[aria-label="Pool name"]')).toBeNull();
    const search=host.querySelector<HTMLInputElement>('[aria-label="Search pools"]')!;
    const type=(value:string)=>flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(search,value);search.dispatchEvent(new Event("input",{bubbles:true}));});
    type("engineering");
    const rows=()=>Array.from(sidebar.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));
    expect(rows().map(row=>row.getAttribute("aria-label"))).toEqual(["Engineering · 0 members"]);
    flushSync(()=>rows()[0]!.click());await settle();
    expect(rows()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(rows()[0]!.classList).toContain("bg-accent");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Pool name"]')!.value).toBe("Engineering");
    type("missing"); expect(sidebar.textContent).toContain("No pools found");
    flushSync(()=>button("Clear pool search").click());
    expect(search.value).toBe("");expect(rows()).toHaveLength(2);
    expect(button("Add pool").querySelector("svg")).toBeTruthy();
    flushSync(()=>button("Add pool").click());
    expect(host.querySelector<HTMLInputElement>('[aria-label="Pool name"]')!.value).toBe("");
    expect(rows().every(row=>row.getAttribute("aria-pressed")==="false")).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
  } finally {flushSync(()=>root.unmount());client.clear();host.remove();}
});

it("filters hundreds of pools without repeatedly normalizing every name", async () => {
  let nameReads=0;
  const pools=Array.from({length:500},(_,index)=>({id:`pool-${index}`,get name(){if(++nameReads>6000)throw new Error("Pool names rescanned too often");return `Pool ${String(index).padStart(4,"0")}`;},revision:1,schemaVersion:2,kind:"harness_pool",enabled:true,mode:"failover",members:[]}));
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]});mocks.legacy.mockResolvedValue([]);mocks.pools.mockResolvedValue(pools);
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try {
    flushSync(()=>root.render(<QueryClientProvider client={client}><TooltipProvider><HarnessPoolSettings companyId="company" /></TooltipProvider></QueryClientProvider>));await settle();
    nameReads=0;
    const search=host.querySelector<HTMLInputElement>('[aria-label="Search pools"]')!;
    for(const value of ["pool 0499","POOL 0498"]){
      flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(search,value);search.dispatchEvent(new Event("input",{bubbles:true}));});
      expect(host.querySelectorAll('button[aria-pressed]')).toHaveLength(1);
    }
    expect(nameReads).toBeLessThan(20);
  } finally {flushSync(()=>root.unmount());client.clear();host.remove();}
});
