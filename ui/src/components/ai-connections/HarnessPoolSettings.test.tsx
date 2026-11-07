// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessPoolSettings } from "./HarnessPoolSettings";
const mocks = vi.hoisted(() => ({ pools: vi.fn(), accounts: vi.fn(), save: vi.fn(), legacy: vi.fn(), inspect: vi.fn(), convert: vi.fn(), archive: vi.fn() }));
vi.mock("@/api/harness-pools", () => ({ harnessPoolsApi: { list: mocks.pools, save: mocks.save, inspect: mocks.inspect, convert: mocks.convert, archive: mocks.archive } }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: mocks.accounts } }));
vi.mock("@/api/ai-connection-pools", () => ({ aiConnectionPoolsApi: { list: mocks.legacy } }));
afterEach(() => vi.clearAllMocks());
async function settle() { for(let i=0;i<8;i++) { await new Promise(resolve=>setTimeout(resolve,0)); flushSync(()=>{}); } }
it("creates a named pool with ordered models on the same account and leaves other pools intact", async () => {
  const account = { id: crypto.randomUUID(), grantId: crypto.randomUUID(), name: "Shared Codex", ownership: "shared", provider: "openai", method: "api_key" };
  mocks.pools.mockResolvedValue([]); mocks.legacy.mockResolvedValue([]); mocks.inspect.mockResolvedValue({ members: {}, usedBy: [] });
  mocks.accounts.mockResolvedValue({ canManageConnections:true, connections:[account] });
  mocks.save.mockImplementation(async (_company, body) => ({ ...body.config, id:crypto.randomUUID(), companyId:"company", revision:1 }));
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  flushSync(()=>root.render(<QueryClientProvider client={client}><HarnessPoolSettings companyId="company" /></QueryClientProvider>)); await settle();
  const click=(text:string)=>{ const button=Array.from(host.querySelectorAll("button")).find(item=>item.textContent===text)!; expect(button).toBeTruthy(); flushSync(()=>button.click()); };
  click("Smart"); click("Add member"); click("Add member");
  const models=host.querySelectorAll<HTMLInputElement>('input[aria-label="Model"]'); expect(models).toHaveLength(2);
  const change=(input:HTMLInputElement,value:string)=>{ Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value); flushSync(()=>input.dispatchEvent(new Event("input",{bubbles:true}))); };
  change(models[0]!,"smart-a"); change(models[1]!,"smart-b");
  click("Save pool"); await settle();
  expect(mocks.save).toHaveBeenCalledWith("company",expect.objectContaining({ config:expect.objectContaining({name:"Smart",schemaVersion:2,members:[expect.objectContaining({model:"smart-a",connection:expect.objectContaining({connectionId:account.id})}),expect.objectContaining({model:"smart-b",connection:expect.objectContaining({connectionId:account.id})})]}) }));
  flushSync(()=>root.unmount()); client.clear();host.remove();
});

it.each(["Mid", "Cheap"])("starts a customisable %s draft without changing existing pools", async name => {
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]});mocks.pools.mockResolvedValue([]);mocks.legacy.mockResolvedValue([]);
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><HarnessPoolSettings companyId="company" /></QueryClientProvider>));await settle();flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.textContent===name)!.click());expect(host.querySelector<HTMLInputElement>('[aria-label="Pool name"]')!.value).toBe(name);expect(mocks.save).not.toHaveBeenCalled();}
  finally{flushSync(()=>root.unmount());client.clear();host.remove();}
});
it("does not load or disclose managed pool members without management permission", async()=>{
  mocks.accounts.mockResolvedValue({canManageConnections:false,connections:[]});mocks.pools.mockResolvedValue([{name:"Private pool"}]);
  const host=document.createElement("div");const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><HarnessPoolSettings companyId="company" /></QueryClientProvider>));await settle();expect(mocks.pools).not.toHaveBeenCalled();expect(host.textContent).toContain("permission is required");expect(host.textContent).not.toContain("Private pool");}
  finally{flushSync(()=>root.unmount());client.clear();}
});
it("requires an explicit confirmation after conversion preview", async()=>{
  mocks.accounts.mockResolvedValue({canManageConnections:true,connections:[]});mocks.pools.mockResolvedValue([]);mocks.legacy.mockResolvedValue([{id:"old",name:"Old pool",revision:4,pluginKey:"paperclip.builtin.ordered-failover",mode:"failover"}]);
  mocks.convert.mockResolvedValue({id:"old",name:"Old pool",revision:4,members:[]});
  const host=document.createElement("div");const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><HarnessPoolSettings companyId="company" /></QueryClientProvider>));await settle();flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Preview conversion: Old pool")!.click());await settle();expect(mocks.convert).toHaveBeenCalledWith("company","old",4,true);expect(mocks.convert).toHaveBeenCalledTimes(1);flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Convert pool")!.click());await settle();expect(mocks.convert).toHaveBeenCalledWith("company","old",4,false);}
  finally{flushSync(()=>root.unmount());client.clear();}
});
