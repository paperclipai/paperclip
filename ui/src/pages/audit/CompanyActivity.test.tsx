// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CompanyActivity } from "./CompanyActivity.production";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: false }) }));
vi.mock("@/lib/router", () => ({
  useSearchParams: () => [new URLSearchParams("entityType=case&entityId=CAS-C1&action=case."), vi.fn()],
}));
vi.mock("./AuditHub", () => ({ AuditHub: () => <div>Audit hub</div> }));
vi.mock("./AuditFeed", () => ({
  AuditFeed: (props: { companyId: string; lockedEntity?: { type: string; id: string }; actionDomain: string }) => (
    <div data-company={props.companyId} data-entity={JSON.stringify(props.lockedEntity)} data-action={props.actionDomain} />
  ),
}));

it("preserves case audit links when the streamlined shell is off", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CompanyActivity />));
    expect(container.firstElementChild?.getAttribute("data-company")).toBe("company-1");
    expect(container.firstElementChild?.getAttribute("data-entity")).toBe(JSON.stringify({ type: "case", id: "CAS-C1" }));
    expect(container.firstElementChild?.getAttribute("data-action")).toBe("case.");
  } finally {
    await act(async () => root.unmount());
  }
});
