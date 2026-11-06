// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { ResponsibleOwnerRow } from "./ResponsibleOwnerRow";

const mocks = vi.hoisted(() => ({ access: vi.fn(), transfer: vi.fn() }));
vi.mock("../../api/issues", () => ({ issuesApi: { responsibleOwnerAccess: mocks.access, transferResponsibleOwner: mocks.transfer } }));
vi.mock("../../api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [
  { principalId: "owner", user: { name: "Ada" } }, { principalId: "next", user: { name: "Grace" } },
] }) } }));
vi.mock("../ui/select", () => ({
  Select: ({ value, onValueChange, disabled, children }: any) => <select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>{children}</select>,
  SelectContent: ({ children }: any) => children,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
  SelectTrigger: () => null, SelectValue: () => null,
}));
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let client: QueryClient;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); client?.clear(); vi.clearAllMocks(); });
async function render(canTransfer: boolean, changes = {}) {
  mocks.access.mockResolvedValue({ canTransfer });
  mocks.transfer.mockResolvedValue({});
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const issue = { id: "task", companyId: "company", responsibleUserId: "owner", createdByUserId: "creator", ...changes } as Issue;
  await act(async () => { root.render(<QueryClientProvider client={client}><ResponsibleOwnerRow issue={issue} /></QueryClientProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
it("shows the owner without an edit control to unauthorized users", async () => {
  await render(false);
  expect(container.textContent).toContain("Ada");
  expect(container.querySelector("select")).toBeNull();
});
it("transfers to a company user with the observed owner", async () => {
  await render(true);
  const select = container.querySelector("select")!;
  expect(select.disabled).toBe(false);
  await act(async () => { select.value = "next"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(mocks.transfer).toHaveBeenCalledWith("task", "next", "owner");
});
it("disables transfers during active execution and explains why", async () => {
  await render(true, { executionRunId: "run" });
  expect(container.querySelector("select")!.disabled).toBe(true);
  expect(container.textContent).toContain("Stop the active run");
});
it("shows server errors", async () => {
  await render(true);
  mocks.transfer.mockRejectedValue(new Error("The responsible owner changed"));
  const select = container.querySelector("select")!;
  await act(async () => { select.value = "next"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("The responsible owner changed");
});
