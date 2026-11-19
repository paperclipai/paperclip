// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CompanyPools } from "./CompanyPools";
const state = vi.hoisted(() => ({ companyId: "company", breadcrumbs: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId, selectedCompany: {name:"Company"} }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({setBreadcrumbs:state.breadcrumbs}) }));
vi.mock("../components/ai-connections/HarnessPoolSettings", () => ({ HarnessPoolSettings: ({companyId}:{companyId:string}) => <section data-company={companyId}>Pool editor</section> }));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
it("mounts the dedicated company pool editor and labels its settings breadcrumb", async () => {
  const host=document.createElement("div"),root=createRoot(host);
  try {
    await act(async()=>root.render(<CompanyPools />));
    expect(host.querySelector("section")?.dataset.company).toBe("company");
    expect(state.breadcrumbs).toHaveBeenCalledWith(expect.arrayContaining([{label:"Pools"}]));
    state.companyId="";
    await act(async()=>root.render(<CompanyPools />));
    expect(host.querySelector("section")).toBeNull();
    expect(host.textContent).toContain("No organization selected");
  } finally {act(()=>root.unmount());state.companyId="company";}
});
