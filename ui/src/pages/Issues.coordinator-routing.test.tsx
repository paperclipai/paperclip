// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { Issues } from "./Issues";
import { Inbox } from "./Inbox";

vi.mock("../context/DesignSandboxContext", () => ({ useDesignSandbox: () => false }));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, loaded: true, userId: "viewer" }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("../hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { issuePrefix: "ORG" } }) }));
vi.mock("./CoordinatorTasks", () => ({ CoordinatorTasks: () => <p>Coordinator tasks</p> }));
vi.mock("./Inbox", () => ({ Inbox: ({ tab, surfaceLabel }: { tab: string; surfaceLabel: string }) => <p>{surfaceLabel} Inbox owner:{tab}</p> }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));

beforeEach(() => localStorage.clear());

function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}{location.hash}</output>; }
function render(url: string) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  flushSync(() => root.render(<MemoryRouter initialEntries={[url]}><Location /><Routes>
    <Route path="/ORG/issues" element={<Issues />} /><Route path="/ORG/inbox/:tab" element={<Inbox />} />
  </Routes></MemoryRouter>));
  return { host, cleanup: () => { flushSync(() => root.unmount()); host.remove(); } };
}
it.each([["mine", "mine"], ["inbox", "mine"], ["unread", "unread"], ["blocked", "blocked"], ["recent", "recent"], ["everything", "all"]])("hosts saved %s links in Tasks with the original personal-work owner", async (view, tab) => {
  const { host, cleanup } = render(`/ORG/issues?view=${view}&sort=oldest#saved`);
  try {
    await vi.waitFor(() => expect(host.textContent).toContain(`Inbox owner:${tab}`));
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe(`/ORG/issues?view=${view === "inbox" ? "mine" : view}&sort=oldest#saved`));
    expect(host.textContent).not.toContain("Coordinator tasks");
  } finally { cleanup(); }
});
it.each(["needs_attention", "all"])("keeps the %s task view in Coordinator", view => {
  const { host, cleanup } = render(`/ORG/issues?view=${view}`);
  try { expect(host.textContent).toContain("Coordinator tasks"); expect(host.textContent).not.toContain("Inbox owner"); }
  finally { cleanup(); }
});
it.each(["workspace=workspace", "originKind=routine_execution"])("keeps organization-scoped task links out of Inbox: %s", filter => {
  const { host, cleanup } = render(`/ORG/issues?view=mine&${filter}`);
  try { expect(host.textContent).toContain("Coordinator tasks"); expect(host.textContent).not.toContain("Inbox owner"); }
  finally { cleanup(); }
});

it.each(["mine", "blocked", "recent", "everything"])("keeps shared %s label links on the Coordinator collection", async view => {
  const url = `/ORG/issues?view=${view}&label=qa&label=review&sortField=taskId&sortDir=asc&keep=value#saved`;
  const { host, cleanup } = render(url);
  try {
    await vi.waitFor(() => expect(host.textContent).toContain("Coordinator tasks"));
    expect(host.textContent).not.toContain("Inbox owner");
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe(url.replace(`view=${view}`, "view=all")));
  } finally { cleanup(); }
});

it("defaults Tasks to Mine and remembers a deliberate organization view", async () => {
  const first = render("/ORG/issues");
  try {
    await vi.waitFor(() => expect(first.host.querySelector("output")?.textContent).toBe("/ORG/issues?view=mine"));
    expect(first.host.textContent).toContain("Tasks Inbox owner:mine");
  } finally { first.cleanup(); }
  const selected = render("/ORG/issues?view=done");
  try {
    await vi.waitFor(() => expect(localStorage.getItem(JSON.stringify(["paperclip:coordinator-task-view:v2", "company", "viewer"]))).toBe("done"));
  } finally { selected.cleanup(); }
  const returned = render("/ORG/issues");
  try {
    await vi.waitFor(() => expect(returned.host.querySelector("output")?.textContent).toBe("/ORG/issues?view=done"));
    expect(returned.host.textContent).toContain("Coordinator tasks");
  } finally { returned.cleanup(); }
});
