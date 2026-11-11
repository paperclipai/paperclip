// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceOnboarding } from "./WorkspaceOnboarding";

const state = vi.hoisted(() => ({ companies: [] as object[], loading: false, createCompany: vi.fn(), setSelectedCompanyId: vi.fn(),
  onboardingOpen: true, onboardingOptions: {} as { companyId?: string }, pathname: "/onboarding", navigate: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => state }));
vi.mock("../context/DialogContext", () => ({ useDialogState: () => state }));
vi.mock("../lib/router", () => ({ useLocation: () => state, useNavigate: () => state.navigate }));
let host: HTMLDivElement;
let root: Root;
const close = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); state.companies = []; state.onboardingOptions = {}; state.onboardingOpen = true; state.loading = false;
  state.createCompany.mockResolvedValue({ id: "workspace-a", issuePrefix: "MAR" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("creates only the workspace and proceeds to explicit agent selection", async () => {
  await act(async () => root.render(<WorkspaceOnboarding open onClose={close} />));
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Marca A");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(state.createCompany).toHaveBeenCalledExactlyOnceWith({ name: "Marca A", description: null });
  expect(state.setSelectedCompanyId).toHaveBeenCalledWith("workspace-a");
  expect(state.navigate).toHaveBeenCalledWith("/MAR/agents/new");
  expect(close).toHaveBeenCalledOnce();
});
it("does not create a replacement for an inaccessible workspace", async () => {
  state.onboardingOptions = { companyId: "other-workspace" };
  await act(async () => root.render(<WorkspaceOnboarding open onClose={close} />));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("indisponível");
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(state.createCompany).not.toHaveBeenCalled();
});
it("closes when the overlay request ends", async () => {
  await act(async () => root.render(<WorkspaceOnboarding open onClose={close} />));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => root.render(<WorkspaceOnboarding open={false} onClose={close} />));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
