// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { PoolAgentSetup } from "./PoolAgentSetup";
const mocks=vi.hoisted(()=>({ get:vi.fn(), pools:vi.fn(), test:vi.fn(), hire:vi.fn(), navigate:vi.fn(), update:vi.fn(), toast:vi.fn() }));
vi.mock("@/api/agents",()=>({agentsApi:{get:mocks.get,testEnvironment:mocks.test,hire:mocks.hire,update:mocks.update}}));
vi.mock("@/api/harness-pools",()=>({harnessPoolsApi:{choices:mocks.pools}}));
vi.mock("@/api/instanceSettings",()=>({instanceSettingsApi:{getExperimental:async()=>({enableNativeRunner:true})}}));
vi.mock("@/lib/router",()=>({useNavigate:()=>mocks.navigate}));
vi.mock("@/context/ToastContext",()=>({useToastActions:()=>({pushToast:mocks.toast})}));
afterEach(()=>vi.clearAllMocks());
async function settle(){for(let i=0;i<8;i++){await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});}}
it.each(["pass","warn"])("checks the shared pool and keeps provider warnings visible (%s)",async status=>{
  mocks.get.mockResolvedValue({id:"agent",name:"Ada",role:"general",reportsTo:null,defaultEnvironmentId:null,runtimeConfig:{heartbeat:{enabled:false},aiConnection:{old:true}}});
  mocks.pools.mockResolvedValue([{id:"smart",name:"Smart",enabled:true}]); mocks.test.mockResolvedValue({status,checks:status==="warn"?[{level:"warn",code:"ai_connection_pool_task_test_required",message:"Run a task to verify the selected account and harness."}]:[]});mocks.hire.mockResolvedValue({agent:{id:"agent"}});
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><PoolAgentSetup companyId="company" agentId="agent" /></QueryClientProvider>));await settle();
    const select=host.querySelector<HTMLSelectElement>('[aria-label="Harness pool"]')!;flushSync(()=>{select.value="smart";select.dispatchEvent(new Event("change",{bubbles:true}));});
    const finish=Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Finish setup")!;flushSync(()=>finish.click());await settle();
    expect(mocks.test).toHaveBeenCalledWith("company","paperclip_runner",expect.objectContaining({agentId:"agent",aiConnection:{mode:"router",connectionId:"smart"},runner:"paperclip"}));
    expect(mocks.hire).toHaveBeenCalledWith("company",expect.objectContaining({setupAgentId:"agent",adapterType:"paperclip_runner",runtimeConfig:expect.objectContaining({harnessPool:{poolId:"smart"}})}));
    if(status==="warn")expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({tone:"warn",body:"Run a task to verify the selected account and harness."}));else expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.hire.mock.calls[0]![1].runtimeConfig.aiConnection).toBeUndefined();expect(mocks.navigate).toHaveBeenCalledWith("/agents/agent");
  }finally{flushSync(()=>root.unmount());client.clear();host.remove();}
});

it("saves the Pool draft without testing or releasing the setup hold",async()=>{
  mocks.get.mockResolvedValue({id:"agent",name:"Ada",runtimeConfig:{aiConnection:{old:true}}});mocks.pools.mockResolvedValue([{id:"smart",name:"Smart",enabled:true}]);mocks.update.mockResolvedValue({id:"agent"});
  const host=document.createElement("div");const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><PoolAgentSetup companyId="company" agentId="agent" /></QueryClientProvider>));await settle();const select=host.querySelector<HTMLSelectElement>('[aria-label="Harness pool"]')!;flushSync(()=>{select.value="smart";select.dispatchEvent(new Event("change",{bubbles:true}));});flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Save & exit")!.click());await settle();expect(mocks.update).toHaveBeenCalledWith("agent",expect.objectContaining({runtimeConfig:{harnessPool:{poolId:"smart"}}}),"company");expect(mocks.test).not.toHaveBeenCalled();expect(mocks.hire).not.toHaveBeenCalled();expect(mocks.update.mock.calls[0]![1].status).toBeUndefined();}
  finally{flushSync(()=>root.unmount());client.clear();}
});
it("keeps the draft held when its selected pool test fails",async()=>{
  mocks.get.mockResolvedValue({id:"agent",name:"Ada",runtimeConfig:{}});mocks.pools.mockResolvedValue([{id:"smart",name:"Smart",enabled:true}]);mocks.test.mockResolvedValue({status:"fail",checks:[{level:"error",code:"missing",message:"Repair the selected account"}]});
  const host=document.createElement("div");const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{flushSync(()=>root.render(<QueryClientProvider client={client}><PoolAgentSetup companyId="company" agentId="agent" /></QueryClientProvider>));await settle();const select=host.querySelector<HTMLSelectElement>('[aria-label="Harness pool"]')!;flushSync(()=>{select.value="smart";select.dispatchEvent(new Event("change",{bubbles:true}));});flushSync(()=>Array.from(host.querySelectorAll("button")).find(button=>button.textContent==="Finish setup")!.click());await settle();expect(mocks.hire).not.toHaveBeenCalled();expect(host.querySelector('[role="alert"]')?.textContent).toContain("Repair the selected account");}
  finally{flushSync(()=>root.unmount());client.clear();}
});
