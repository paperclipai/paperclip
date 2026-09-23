// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTriggerDraft, RoutineTriggerWizard, webhookAgentInstructions } from "./TriggerWizard";

const { setBreadcrumbs } = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: () => {} }) }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => <span>Fireflies logo</span> }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("offers Fireflies and explains the public HTTPS requirement before creating a trigger", async () => {
  await act(async () => root.render(<RoutineTriggerWizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook", sender: "fireflies" }} routineTitle="Process meetings" routineId="routine-1" onSaveExit={() => {}} onFinish={() => {}} />));
  expect(container.textContent).toContain("Fireflies — Summary ready");
  expect(container.textContent).toContain("publicly reachable HTTPS");
});

it("resumes Fireflies setup with the provider settings link and a separate signing secret", async () => {
  const onSaveExit = vi.fn();
  await act(async () => root.render(<RoutineTriggerWizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook", sender: "fireflies", created: true, step: 1, availableStep: 1 }} routineTitle="Process meetings" routineId="routine-1" webhookUrl="https://paperclip.example/api/routine-triggers/public/test/fire" webhookSecret="test-signing-secret" onSaveExit={onSaveExit} onFinish={() => {}} />));
  expect(container.querySelector('a[href="https://app.fireflies.ai/integrations/api/webhook"]')).not.toBeNull();
  expect(container.textContent).toContain("Signing Secret");
  expect(container.textContent).toContain("meeting.summarized");
  expect(container.textContent).not.toContain("Bearer test-signing-secret");
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save & exit"))!;
  await act(async () => save.click());
  expect(onSaveExit).toHaveBeenCalledWith(expect.objectContaining({ sender: "fireflies", step: 1, created: true }));
});

it("provides correct agent setup instructions without an API key or bearer header", () => {
  const instructions = webhookAgentInstructions("fireflies", "Meetings", "https://paperclip.example/webhook", "signing-secret");
  expect(instructions).toContain("Signing Secret: signing-secret");
  expect(instructions).toContain("X-Hub-Signature");
  expect(instructions).toContain("meeting.summarized");
  expect(instructions).toContain("They do not start the routine");
  expect(instructions).not.toContain("Authorization: Bearer");
});
