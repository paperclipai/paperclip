// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { VOICE_REPEAT_NOTIFICATION, VOICE_RESULT_NOTIFICATION, VoiceSessionStartError, type VoiceMediaCallbacks, type VoiceMediaCredentials } from "@/lib/voice-session-controller";
import { VoiceConversationPanel } from "./VoiceConversationPanel";

const credentials: VoiceMediaCredentials = { sessionId: "session-a", generation: 2, transportToken: "test-token", transportUrl: "wss://media.example.test" };
afterEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage("en"); });

it.each([
  ["mute", "674fed3c9c84"], ["notification", "fe00e48cf30a"], ["repeat", "0b6904308873"],
  ["mint", "93e82d4eb614"], ["connection", "93e82d4eb614"], ["credits", "3983c1d1558e"],
  ["recovery", "6bbc5f9e8ee9"], ["cleanup", "1b9c4ba3ce67"], ["playback", "7ec5e82f3664"],
])("relocalizes a real %s failure without repeating actions and clears it after success", async (scenario, key) => {
  await i18n.changeLanguage("en");
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let callbacks!: VoiceMediaCallbacks;
  // Exact first-party English collision must remain an opaque provider message.
  const cause = new Error("Failed to fetch");
  const media = { endSession: vi.fn(async () => {}), setMicMuted: vi.fn(async (_muted: boolean) => {}), sendChatMessage: vi.fn(async (_text: string) => {}), startAudioPlayback: vi.fn(async () => {}) };
  const dependencies = { mint: vi.fn(async () => credentials), end: vi.fn(async (_id: string) => {}), connect: vi.fn(async (_credentials: VoiceMediaCredentials, cb: VoiceMediaCallbacks) => { callbacks = cb; return media; }) };
  if (scenario === "mint") dependencies.mint.mockRejectedValueOnce(cause);
  if (scenario === "connection") dependencies.connect.mockRejectedValueOnce(cause);
  if (scenario === "credits" || scenario === "recovery") dependencies.mint.mockRejectedValueOnce(new VoiceSessionStartError("session-a", scenario === "credits" ? "credits_required" : undefined));
  if (scenario === "cleanup") dependencies.end.mockRejectedValueOnce(cause);
  if (scenario === "mute") media.setMicMuted.mockRejectedValueOnce(cause);
  if (scenario === "notification" || scenario === "repeat") media.sendChatMessage.mockRejectedValueOnce(cause);
  if (scenario === "playback") media.startAudioPlayback.mockRejectedValueOnce(cause);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let notification: { sessionId: string; generation: number; publicationId: string; attempt?: number } | undefined;
  const render = () => root.render(<VoiceConversationPanel agentName="Custom Agent" dependencies={dependencies} autoStart notification={notification} />);
  const click = async (text: string) => {
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
    expect(button, text).toBeDefined();
    await act(async () => button!.click());
  };
  const calls = () => [...Object.values(dependencies), ...Object.values(media)].map((fn) => fn.mock.calls.length);
  const suffix = scenario === "cleanup" || scenario === "playback" ? ` ${cause.message}` : "";
  try {
    await act(async () => render());
    if (scenario === "mute") await click("Mute");
    if (scenario === "repeat") await click("Repeat answer");
    if (scenario === "cleanup") await click("End call");
    if (scenario === "notification") {
      notification = { ...credentials, publicationId: "publication-a" };
      await act(async () => render());
      expect(media.sendChatMessage).toHaveBeenLastCalledWith(VOICE_RESULT_NOTIFICATION);
    }
    if (scenario === "repeat") expect(media.sendChatMessage).toHaveBeenLastCalledWith(VOICE_REPEAT_NOTIFICATION);
    if (scenario === "playback") {
      await act(async () => callbacks.onAudioPlaybackBlocked());
      await click("Enable audio");
    }
    const english = i18n.t(`display:copy_${key}`);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(english + suffix);
    // Unrelated snapshot changes must not freeze translated copy either.
    if (["mute", "repeat", "notification", "playback"].includes(scenario)) {
      await act(async () => callbacks.onMessage({ source: "agent", segmentId: "raw", text: "Provider text stays verbatim", isFinal: true }));
    }
    const before = calls();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    const chinese = i18n.t(`display:copy_${key}`);
    expect(chinese).not.toBe(english);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(chinese + suffix);
    expect(calls()).toEqual(before);
    if (scenario === "cleanup") {
      expect([...host.querySelectorAll("button")].find((node) => node.textContent === i18n.t("connections:mute_0f09734"))?.disabled).toBe(true);
      expect(dependencies.mint).toHaveBeenCalledOnce();
    }
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(english + suffix);
    expect(calls()).toEqual(before);
    if (scenario === "notification") {
      now += 20_000;
      notification = { ...notification!, attempt: 1 };
      await act(async () => render());
    } else {
      await click(({ mute: "Mute", repeat: "Repeat answer", cleanup: "Retry ending call", playback: "Enable audio" } as Record<string, string>)[scenario] ?? "Try again");
    }
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    if (["mute", "repeat", "notification", "playback"].includes(scenario)) {
      expect(host.textContent).toContain("Provider text stays verbatim");
      expect(dependencies.mint).toHaveBeenCalledOnce();
      expect(dependencies.connect).toHaveBeenCalledOnce();
    }
    if (scenario === "cleanup") {
      expect(media.endSession).toHaveBeenCalledOnce();
      expect(dependencies.end).toHaveBeenCalledTimes(2);
    }
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});
