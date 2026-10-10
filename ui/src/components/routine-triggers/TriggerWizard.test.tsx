// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTriggerDraft, RoutineTriggerWizard, webhookAgentInstructions } from "./TriggerWizard";

const { setBreadcrumbs } = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: () => {} }) }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("offers the shared app flow without a Fireflies-specific sender", async () => {
  await act(async () => root.render(<RoutineTriggerWizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook" }} routineTitle="Process meetings" routineId="routine-1" onSaveExit={() => {}} onFinish={() => {}} />));
  expect(container.textContent).toContain("Another app or script");
  expect(container.textContent).not.toContain("Fireflies");
  expect(container.textContent).toContain("publicly reachable HTTPS");
});

it("resumes generic setup with a signing secret and preserves the draft", async () => {
  const onSaveExit = vi.fn();
  await act(async () => root.render(<RoutineTriggerWizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook", created: true, step: 1, availableStep: 1 }} routineTitle="Process meetings" routineId="routine-1" webhookUrl="https://paperclip.example/api/routine-triggers/public/test/fire" webhookSecret="test-signing-secret" onSaveExit={onSaveExit} onFinish={() => {}} />));
  expect(container.textContent).toContain("Secret key");
  expect(container.textContent).toContain("signing secret field");
  expect(container.textContent).not.toContain("Fireflies");
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save & exit"))!;
  await act(async () => save.click());
  expect(onSaveExit).toHaveBeenCalledWith(expect.objectContaining({ sender: "custom", step: 1, created: true }));
});

it("explains both supported app authentication methods", () => {
  const instructions = webhookAgentInstructions("custom", "Meetings", "https://paperclip.example/webhook", "signing-secret");
  expect(instructions).toContain("Secret key: signing-secret");
  expect(instructions).toContain("X-Hub-Signature");
  expect(instructions).toContain("Authorization: Bearer signing-secret");
  expect(instructions).toContain("They do not start the routine");
  expect(instructions).not.toContain("Fireflies");
});

it("keeps legacy bearer setup instructions accurate", () => {
  const instructions = webhookAgentInstructions("custom", "Meetings", "https://paperclip.example/webhook", "secret", true, "bearer");
  expect(instructions).toContain("Authorization: Bearer secret");
  expect(instructions).not.toContain("HMAC-SHA256");
});
