// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BootstrapPendingPage } from "./BootstrapPendingPage";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import { setLocale } from "@/i18n";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("bootstrap localization boundaries", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    setLocale("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setLocale("en");
  });

  it("keeps public-mode claim disabled and the exact executable fallback command", async () => {
    const onClaim = vi.fn();
    await act(async () => root.render(<MemoryRouter><BootstrapPendingPage claimAvailable={false} session={null} claimState="idle" onClaim={onClaim} /></MemoryRouter>));
    await act(async () => setLocale("ru"));
    expect(container.textContent).toContain("доступна только по приглашению");
    expect(container.textContent).toContain("В публичном режиме нельзя назначить себя администратором через браузер");
    expect(container.querySelector("pre")?.textContent).toBe(BOOTSTRAP_FALLBACK_COMMAND);
    expect(container.querySelector("button")).toBeNull();
    expect(onClaim).not.toHaveBeenCalled();
  });

  it("retranslates an existing claim error while preserving identity and auth route", async () => {
    const onClaim = vi.fn();
    const session = { session: { id: "session-id", userId: "user-id" }, user: { id: "user-id", name: "Raw user", email: "raw@example.test", image: null }, sentryDsn: null };
    await act(async () => root.render(<MemoryRouter><BootstrapPendingPage claimAvailable session={session} claimState="idle" claimError={{ status: 409 }} onClaim={onClaim} /></MemoryRouter>));
    await act(async () => setLocale("ru"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("У этой установки уже есть администратор");
    expect(container.textContent).toContain("Вы вошли как raw@example.test");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/auth?next=/");
    expect(container.querySelector("a")?.textContent).toBe("Сменить учётную запись");
    expect(onClaim).not.toHaveBeenCalled();
    await act(async () => setLocale("en"));
    expect(container.textContent).toContain("Signed in as raw@example.test");
    expect(container.querySelector("a")?.textContent).toBe("Switch account");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Someone else has already claimed this instance");
  });
});
