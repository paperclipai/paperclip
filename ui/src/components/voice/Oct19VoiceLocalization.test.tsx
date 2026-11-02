// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInboundCall, GrokConnection } from "@paperclipai/shared";
import { i18n, t } from "@/i18n";
import { VoiceControls } from "./VoiceControls";
import { VoiceTranscript } from "./VoiceTranscript";
import { SpekoCallReport } from "./SpekoCallHistory";
import { SpekoIncomingCallCard } from "./SpekoIncomingCalls";
import { SpekoPhoneLineForm } from "./SpekoPhoneLine";
import { voiceControllerErrorLabel } from "./voice-display";
import { externalRunnerStatusLabel } from "@/lib/external-runner-labels";
import { callHistoryFixture } from "../../../storybook/support/speko/spekoCallHistory";
import { MuseConnectionDetails } from "../MuseRunnerConnection";
import { museConnection, stoppedMuseConnection, museStopBoundary } from "../../../storybook/support/external-agent-invite/muse-fixtures";
import { GrokBotSetupContent } from "../new-agent/GrokBotSetupContent";
import { Dialog, DialogContent } from "../ui/dialog";
import { WorkspaceBaseRefRecoveryNotice } from "../WorkspaceBaseRefRecoveryNotice";
import { LockedIssueChip } from "../LockedIssueChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("October 19 voice display boundaries", () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    await i18n.changeLanguage("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); await i18n.changeLanguage("en"); });
  const render = async (node: ReactNode) => act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
  const language = async (locale: string) => act(async () => { await i18n.changeLanguage(locale); });
  const button = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent === label)!;
  const handlers = () => ({ onTest: vi.fn(), onRepair: vi.fn(), onPause: vi.fn(), onDisconnect: vi.fn(), onRefresh: vi.fn(), onAttest: vi.fn() });

  it("refreshes live controls and transcript tails without mutating spoken text or identities", async () => {
    const raw = "A task update is available.";
    const entries = [
      { id: "raw-user", source: "user" as const, text: raw, final: false },
      { id: "raw-agent", source: "agent" as const, text: "Provider text RAW", final: false, interrupted: true },
      { id: "generated", source: "application" as const, text: raw, final: true, generated: "task_update" as const },
    ];
    const before = JSON.stringify(entries), onMute = vi.fn();
    await render(<><VoiceControls state="listening" agentName="This agent" onStart={vi.fn()} onMute={onMute} onEnd={vi.fn()} onResumeAudio={vi.fn()} error="Provider RAW" /><VoiceTranscript entries={entries} agentName="This agent" /></>);
    const transcript = host.querySelector("ol"), mute = button("Mute");
    for (const locale of ["ru", "en", "ru"]) {
      await language(locale);
      expect(host.querySelector("ol")).toBe(transcript);
      expect(host.textContent).toContain(locale === "ru" ? " · говорит" : " · Speaking");
      expect(host.textContent).toContain(locale === "ru" ? " · речь прервана" : " · Interrupted");
      expect(host.querySelectorAll("li p")[0].textContent).toBe(raw);
      expect(host.querySelectorAll("li p")[1].textContent).toBe("Provider text RAW");
      expect(host.querySelectorAll("li p")[2].textContent).toBe(t("oct19Voice.aTaskUpdateIsAvailable_4w9mvl"));
      expect(host.textContent).toContain("This agent");
      expect(host.querySelector('[role="alert"]')?.textContent).toBe("Provider RAW");
      expect(mute.textContent).toBe(t("oct19Voice.mute_hl254k"));
      expect(JSON.stringify(entries)).toBe(before);
    }
    await act(async () => mute.click()); expect(onMute).toHaveBeenCalledOnce();
  });

  it.each([[1, "секунда"], [2, "секунды"], [5, "секунд"], [21, "секунда"]])("uses Russian duration morphology for %i without translating the transcript", async (count, unit) => {
    await language("ru");
    await render(<SpekoCallReport report={{ ...callHistoryFixture.report!, durationSeconds: count as number }} />);
    expect(host.textContent).toContain(`${count} ${unit}`);
    expect(host.textContent).toContain(callHistoryFixture.report!.transcript[0].text);
  });

  it("retains caller approval code and selected task through EN/RU/EN", async () => {
    const onDecide = vi.fn();
    const call = { id: "raw-call", state: "awaiting_approval", approvalCode: "123456" } as VoiceInboundCall;
    const before = JSON.stringify(call);
    await render(<SpekoIncomingCallCard call={call} tasks={[{ id: "task/raw", label: "Task RAW" }]} onDecide={onDecide} />);
    const code = host.querySelector("input")!, select = host.querySelector("select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(code, "123456");
      code.dispatchEvent(new Event("input", { bubbles: true }));
      select.value = "task/raw"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (const locale of ["ru", "en", "ru"]) {
      await language(locale); expect(code.value).toBe("123456"); expect(select.value).toBe("task/raw");
      expect(select.getAttribute("aria-label")).toBe(t("oct19Voice.conversationTask_1wckt7j"));
      expect(host.querySelector("input")).toBe(code); expect(JSON.stringify(call)).toBe(before);
    }
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ approve: true, approvalCode: "123456", issueId: "task/raw" });
  });

  it("keeps Grok acknowledged a canonical readiness state in Russian", async () => {
    const next = vi.fn();
    const connection = { agentLifecycleState: "ready", canConfigureConnection: true, binding: { connected: true,
      routine: { configured: true, verified: true, recoveryNeeded: false, lastExchange: { status: "acknowledged" } } } } as GrokConnection;
    const before = JSON.stringify(connection);
    await render(<Dialog open><DialogContent><GrokBotSetupContent step={3} companyName="Company RAW" details={{ name: "Agent RAW", botName: "Bot RAW" }} created managers={[]} connection={connection} pairing={null} webhookUrl="" webhookKey="" onDetails={vi.fn()} onCredentials={vi.fn()} onBack={vi.fn()} onExit={vi.fn()} onNext={next} onRetry={vi.fn()} /></DialogContent></Dialog>);
    await language("ru");
    expect(document.body.textContent).toContain(t("oct19Voice.yourGrokBotIsConnected_1pow1yr"));
    expect(document.body.textContent).toContain("Bot RAW");
    expect(JSON.stringify(connection)).toBe(before);
    expect([...document.querySelectorAll("button")].filter(b => !b.disabled).length).toBeGreaterThan(0);
  });

  it("retains the exact Muse stop attestation across locale changes", async () => {
    const h = handlers(); await render(<MuseConnectionDetails connection={stoppedMuseConnection} {...h} />);
    await act(async () => button("Attest this worker stopped").click());
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    await language("ru"); expect(checkbox.checked).toBe(true); expect(host.textContent).toContain(museStopBoundary.runId);
    const confirm = button(t("oct19Voice.confirmWorkerStopped_f7o6km")); expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(h.onAttest).toHaveBeenCalledExactlyOnceWith({ boundary: museStopBoundary, expectedRevision: stoppedMuseConnection.binding!.stop.bindingRevision, workerStopped: true });
  });

  it.each([1, 2, 5, 21])("localizes the whole receiver lag warning for %i seconds", async (count) => {
    await language("ru");
    await render(<MuseConnectionDetails connection={{ ...museConnection, binding: { ...museConnection.binding!, contactPersistenceLagMs: count * 1000 } }} {...handlers()} />);
    expect(host.textContent).toContain(t("oct19Voice.receiverLag", { count }));
    expect(host.textContent).not.toContain("may lag by up to");
  });

  it("relocalizes stored validation errors and preserves repair branch payloads and raw errors", async () => {
    const repair = vi.fn().mockRejectedValue(new Error("Provider RAW"));
    await render(<WorkspaceBaseRefRecoveryNotice requestedRef="main" repository="Repo RAW" agentName="Agent RAW" defaultBranch="bad..branch" onRepair={repair} />);
    await act(async () => button("Use bad..branch & retry").click());
    await language("ru"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Введите допустимое имя ветки"); expect(repair).not.toHaveBeenCalled();
    await act(async () => button(t("oct19Voice.branchChoose")).click());
    const input = host.querySelector("input")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "release/next"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(repair).toHaveBeenCalledExactlyOnceWith("release/next");
    await language("en"); expect(input.value).toBe("release/next"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Provider RAW");
  });

  it("localizes access-only stubs without translating real identifiers or exposing a link", async () => {
    await render(<><LockedIssueChip identifier="Private" /><LockedIssueChip identifier={null} unavailable /></>);
    await language("ru"); const chips = host.querySelectorAll('[data-testid="locked-issue-chip"]');
    expect(chips[0].textContent).toBe("Private"); expect(chips[0].getAttribute("aria-label")).toBe("Private — приватная задача, у вас нет доступа");
    expect(chips[1].textContent).toBe("Недоступно"); expect(host.querySelector("a")).toBeNull();
  });

  it("keeps unknown diagnostic and runner values verbatim", async () => {
    await language("ru");
    for (const raw of ["Provider RAW", "constructor", "ready with provider detail"]) {
      expect(voiceControllerErrorLabel(raw)).toBe(raw); expect(externalRunnerStatusLabel(raw)).toBe(raw);
    }
    expect(externalRunnerStatusLabel("ready")).not.toBe("ready");
    expect(voiceControllerErrorLabel("The answer could not be repeated. Open the task to read it.")).not.toContain("The answer");
  });

  it("keeps the real Speko link in the localized whole-message number instructions", async () => {
    await render(<SpekoPhoneLineForm onRefresh={vi.fn()} onSave={vi.fn()} />);
    const link = host.querySelector("a")!;
    for (const locale of ["ru", "en", "ru"]) {
      await language(locale);
      expect(host.querySelector("a")).toBe(link);
      expect(link.getAttribute("href")).toBe("https://platform.speko.ai");
      expect(link.textContent).toContain("Speko");
      if (locale === "ru") expect(link.textContent).toMatch(/[А-Яа-яЁё]/);
      expect(host.textContent).not.toContain("<spekoLink>");
      expect(host.textContent).not.toContain("oct19Voice.");
    }
  });
});
