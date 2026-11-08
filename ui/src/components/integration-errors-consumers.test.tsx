// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useComposerStop } from "@/hooks/useComposerStop";
import { useStagedIssueFiles } from "@/hooks/useStagedIssueFiles";
import { waitForStoppedRuns } from "@/lib/wait-for-stopped-runs";
import { VoiceConversationPanel } from "./voice/VoiceConversationPanel";
import { connectSpekoVoiceMedia } from "@/lib/speko-voice-media";
import { createVoiceCallAttempt } from "@/lib/voice-call-attempt";
import { i18n } from "@/i18n";
import type { VoiceMedia, VoiceSessionDependencies } from "@/lib/voice-session-controller";
import type { voiceSessionsApi } from "@/api/voiceSessions";
const sdk = vi.hoisted(() => ({ canPlaybackAudio: false, startAudioPlayback: vi.fn(async () => {}), endSession: vi.fn(async () => {}) }));
vi.mock("@spekoai/client", () => ({ VoiceConversation: { create: async () => sdk } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); vi.unstubAllGlobals(); await act(async () => { await i18n.changeLanguage("en"); }); });
async function mount(node: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }
async function language(locale: string) { await act(async () => { await i18n.changeLanguage(locale); }); }
it("keeps outer stop verification feedback live and original through the composer hook", async () => {
  let raw!: Error; try { await waitForStoppedRuns(["r"], { getRun: async () => { throw new Error("provider"); } }); } catch (e) { raw = e as Error; }
  let controller!: ReturnType<typeof useComposerStop>;
  function Harness() { controller = useComposerStop(async () => { throw raw; }); return <p role="alert">{controller.error}</p>; }
  await mount(<Harness />); await act(async () => controller.stop());
  expect(host.textContent).toBe(raw.message);
  await language("zh-CN"); expect(host.textContent).toContain("无法验证是否已停止");
  await language("en"); expect(host.textContent).toBe(raw.message);
  raw = new Error(raw.message); await act(async () => controller.stop()); await language("zh-CN"); expect(host.textContent).toBe(raw.message);
});
it("retains blocked draft storage provenance in mounted hook feedback", async () => {
  const request = {} as IDBOpenDBRequest;
  vi.stubGlobal("indexedDB", { open: () => { queueMicrotask(() => request.onblocked?.({} as IDBVersionChangeEvent)); return request; } });
  function Harness() { const draft = useStagedIssueFiles("operator", "company"); return <p role="alert">{draft.error}</p>; }
  await language("en"); await mount(<Harness />); expect(host.textContent).toContain("Draft file storage is blocked");
  await language("zh-CN"); expect(host.textContent).toContain("草稿文件存储被阻止");
  await language("en"); expect(host.textContent).toContain("Draft file storage is blocked");
});
it("shows owned audio-blocked feedback live without reconnecting mounted voice media", async () => {
  const credentials = { sessionId: "s", generation: 1, transportToken: "raw", transportUrl: "raw" };
  let connected!: VoiceMedia; const connect = vi.fn(async (c: Parameters<VoiceSessionDependencies["connect"]>[0], callbacks: Parameters<VoiceSessionDependencies["connect"]>[1]) => { connected = await connectSpekoVoiceMedia(c, callbacks); callbacks.onAudioPlaybackBlocked(); return connected; });
  const mint = vi.fn(async () => credentials);
  const dependencies: VoiceSessionDependencies = { mint, end: async () => {}, connect };
  await language("en"); await mount(<VoiceConversationPanel agentName="raw-agent" dependencies={dependencies} />);
  await act(async () => { (host.querySelector('button[aria-label="Start voice conversation"]') ?? [...host.querySelectorAll("button")].find(b => /start/i.test(b.textContent ?? "")))?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const resume = [...host.querySelectorAll("button")].find(b => /enable audio|play audio|resume audio/i.test((b.textContent ?? "") + b.getAttribute("aria-label")));
  expect(resume).toBeDefined(); await act(async () => { resume!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(host.textContent).toContain("Audio playback remains blocked");
  await language("zh-CN"); expect(host.textContent).toContain("音频播放仍被阻止");
  await language("en"); expect(host.textContent).toContain("Audio playback remains blocked"); expect(mint).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledOnce();
});
it("shows unconfirmed hangup identity without erasing recovery or reminting on language change", async () => {
  const journal = { read: () => undefined, write: vi.fn(), clear: vi.fn() };
  const attempt = createVoiceCallAttempt("company", { end: async () => ({ state: "active" }) } as unknown as typeof voiceSessionsApi, journal);
  const dependencies: VoiceSessionDependencies = { mint: async () => ({ sessionId: "s", generation: 1, transportToken: "raw", transportUrl: "raw" }), end: id => attempt.end(id), connect: async () => ({ endSession: async () => {}, setMicMuted: async () => {}, startAudioPlayback: async () => {}, sendChatMessage: async () => {} }) };
  await language("en"); await mount(<VoiceConversationPanel agentName="raw" dependencies={dependencies} />);
  const click = async (pattern: RegExp) => { const button = [...host.querySelectorAll("button")].find(b => pattern.test((b.textContent ?? "") + b.getAttribute("aria-label"))); expect(button).toBeDefined(); await act(async () => { button!.click(); }); };
  await click(/start/i); await click(/end/i); expect(host.textContent).toContain("Speko has not confirmed hangup yet");
  await language("zh-CN"); expect(host.textContent).toContain("Speko 尚未确认挂断");
  await language("en"); expect(host.textContent).toContain("Speko has not confirmed hangup yet"); expect(journal.clear).not.toHaveBeenCalled();
});
