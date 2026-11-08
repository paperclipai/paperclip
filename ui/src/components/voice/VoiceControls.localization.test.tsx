// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { VoiceControls } from "./VoiceControls";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("updates mounted voice controls and accessible sentences when the locale changes", async () => {
  await i18n.changeLanguage("en");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const noop = () => {};
  try {
    await act(async () => root.render(<VoiceControls state="listening" agentName="Ada" onStart={noop} onMute={noop} onEnd={noop} onResumeAudio={noop} />));
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Voice conversation with Ada");
    expect(host.textContent).toContain("Listening");
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("与 Ada 进行语音对话");
    expect(host.textContent).toContain("正在聆听");
    expect(host.textContent).toContain("结束通话");
    expect(host.textContent).not.toContain("End call");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(host.textContent).toContain("End call");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
