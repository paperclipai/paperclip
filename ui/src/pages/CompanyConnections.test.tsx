// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CompanyConnections } from "./CompanyConnections";
const flags = vi.hoisted(() => ({ enabled: false, loaded: false }));
const breadcrumbs = vi.hoisted(() => vi.fn());
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { name: "Company" } }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: breadcrumbs }) }));
vi.mock("../hooks/useFastResponsesEnabled", () => ({ useFastResponsesEnabled: () => flags }));
vi.mock("../components/decision-models/DecisionModelSettings", () => ({ DecisionModelSettingsSection: () => <section>Decision model</section> }));
vi.mock("../components/prompt-injection-prevention/PromptInjectionPreventionSettings", () => ({ PromptInjectionPreventionSettingsSection: () => <section>Prompt Injection Prevention</section> }));
vi.mock("../components/fast-responses/FastResponseSettings", () => ({ FastResponseSettingsSection: () => <section>Fast response</section> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.each([[false,false],[false,true],[true,true]])("shows independent connections when fast response enabled=%s loaded=%s", async (enabled, loaded) => {
  Object.assign(flags, { enabled, loaded }); const container = document.createElement("div"), root = createRoot(container);
  try { await act(async () => root.render(<CompanyConnections />)); expect([...container.querySelectorAll("section")].map(s => s.textContent)).toEqual(["Decision model", "Prompt Injection Prevention", ...(enabled ? ["Fast response"] : [])]); }
  finally { act(() => root.unmount()); }
});
