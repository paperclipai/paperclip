// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { Issues } from "./Issues";
import { Inbox } from "./Inbox";

vi.mock("../context/DesignSandboxContext", () => ({ useDesignSandbox: () => false }));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("../hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { issuePrefix: "ORG" } }) }));
vi.mock("./CoordinatorTasks", () => ({ CoordinatorTasks: () => <p>Coordinator tasks</p> }));
vi.mock("./Inbox", () => ({ Inbox: () => { const { tab } = useParams(); return <p>Inbox owner:{tab}</p>; } }));

function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}{location.hash}</output>; }
function render(url: string) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  flushSync(() => root.render(<MemoryRouter initialEntries={[url]}><Location /><Routes>
    <Route path="/ORG/issues" element={<Issues />} /><Route path="/ORG/inbox/:tab" element={<Inbox />} />
  </Routes></MemoryRouter>));
  return { host, cleanup: () => { flushSync(() => root.unmount()); host.remove(); } };
}
it.each([["mine", "mine"], ["unread", "unread"], ["blocked", "blocked"], ["recent", "recent"], ["everything", "all"]])("opens saved %s links in the original Inbox owner", async (view, tab) => {
  const { host, cleanup } = render(`/ORG/issues?view=${view}&sort=oldest#saved`);
  try {
    await vi.waitFor(() => expect(host.textContent).toContain(`Inbox owner:${tab}`));
    expect(host.querySelector("output")?.textContent).toBe(`/ORG/inbox/${tab}?sort=oldest#saved`);
    expect(host.textContent).not.toContain("Coordinator tasks");
  } finally { cleanup(); }
});
it("keeps organization-scoped task links out of Inbox", () => {
  const { host, cleanup } = render("/ORG/issues?view=mine&workspace=workspace");
  try { expect(host.textContent).toContain("Coordinator tasks"); expect(host.textContent).not.toContain("Inbox owner"); }
  finally { cleanup(); }
});
