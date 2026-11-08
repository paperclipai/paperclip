// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/context/ThemeContext";
import DesignSandboxTaskThread from "./DesignSandboxTaskThread";
import { THREAD_PREVIEW_CASES } from "./task-thread-fixtures";
import { transcriptToTaskChatItems } from "../task-chat/transcript-adapter";

// Real composer behavior is covered in the browser. Retain its takeover slots
// and callbacks here; the transcript/history/protocol surfaces are all real.
vi.mock("../task-chat/TaskChatComposer", async () => {
  const { TaskChatPausedTakeover } = await import("../task-chat/TaskChatPausedTakeover");
  return { TaskChatComposer: ({ onAdd, takeover, pause, onStop }: {
    onAdd: (body: string) => void; takeover?: { content: ReactNode } | null;
    pause?: Parameters<typeof TaskChatPausedTakeover>[0]; onStop?: () => void;
  }) => pause ? <TaskChatPausedTakeover {...pause} /> : takeover ? takeover.content : <>
    <button onClick={() => onAdd("Please check timeouts.")}>Send synthetic reply</button>
    {onStop ? <button onClick={onStop}>Stop synthetic run</button> : null}
  </> };
});
let host: HTMLDivElement;
let root: Root;
const network = vi.fn();
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  network.mockReset();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--motion-sandbox-stream-tick");
  document.documentElement.style.removeProperty("--motion-sandbox-playback-step");
});
function render(query = "", defaultConversation = false, previewMode: "catalog" | "playback" = "catalog") {
  flushSync(() => root.render(<MemoryRouter initialEntries={[`/DES/issues/DES-1${query}`]}>
    <ThemeProvider>
      <DesignSandboxTaskThread previewMode={previewMode} header={<h2>Task title</h2>} agentName="Preview engineer" defaultConversation={defaultConversation}>
        <p>Saved conversation</p>
      </DesignSandboxTaskThread>
    </ThemeProvider>
  </MemoryRouter>));
}
function button(label: string) {
  const match = [...host.querySelectorAll("button")].find(el => el.textContent === label);
  expect(match, `button ${label}`).toBeTruthy();
  return match!;
}
it("leaves the saved conversation as the default on ordinary sandbox tasks", () => {
  render();
  expect(host.textContent).toContain("Saved conversation");
  expect(host.querySelector("[data-preview-case]")).toBeNull();
});
it("defaults the demonstration task to a staging-style conversation", () => {
  render("", true);
  expect(host.querySelector('[data-preview-case="staging-conversation"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="task-chat-human-bubble"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="task-chat-bubble-attached-turn"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="task-chat-live-run-pill"]')).not.toBeNull();
  expect(host.textContent).toContain("Thought through the task");
  expect(host.textContent).toContain("Read files");
  expect(host.querySelector('[data-testid="task-chat-runner-turn"]')).toBeNull();
  expect(network).not.toHaveBeenCalled();
});
it("renders every snapshot through real thread surfaces", () => {
  render("?threadPreview=all");
  expect(host.querySelectorAll("[data-preview-case]")).toHaveLength(THREAD_PREVIEW_CASES.length);
  expect(host.querySelector('[data-testid="task-chat-runner-turn"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="paused-composer-takeover"]')).not.toBeNull();
  expect(host.textContent).toContain("Choose a reconnect policy");
  expect(network).not.toHaveBeenCalled();
});
it("keeps completed commentary and tools in the Activity disclosure", async () => {
  render("?threadPreview=completed");
  const summaries = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="task-chat-turn-summary"]')];
  expect(summaries).toHaveLength(2);
  expect(summaries.every(el => el.getAttribute("aria-expanded") === "false")).toBe(true);
  await act(async () => summaries[1].click());
  expect(summaries[1].getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("The follow-up asks how I arrived at the count.");
  expect(host.querySelector('[data-testid="task-chat-activity-phase-toggle"]')).not.toBeNull();
});
it("resolves permissions locally in the composer takeover", async () => {
  render("?threadPreview=awaiting-approval");
  await act(async () => button("Allow once").click());
  expect(host.textContent?.toLowerCase()).toContain("resolved");
  expect(network).not.toHaveBeenCalled();
});
it("stops synthetic activity without touching a real run", async () => {
  render("?threadPreview=working");
  await act(async () => button("Stop synthetic run").click());
  expect(host.textContent).toContain("Run cancelled");
  expect(host.querySelector('[data-testid="task-chat-live-run-pill"]')?.textContent).toContain("Stopped");
  expect(network).not.toHaveBeenCalled();
});
it("keeps the native renderer separate from the staging transcript layout", () => {
  render("?threadPreview=runner-running");
  expect(host.querySelector('[data-testid="task-chat-runner-turn"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="task-chat-live-run-pill"]')).toBeNull();
});
it("preserves failure, incomplete-tool and streaming lifecycles through the real event adapter", () => {
  const itemsFor = (id: string, running: boolean) => transcriptToTaskChatItems(
    THREAD_PREVIEW_CASES.find(item => item.id === id)!.build().entries,
    { runId: "fixture-check", running },
  );
  expect(itemsFor("tool-failed", true)).toContainEqual(expect.objectContaining({ kind: "tool", status: "failed" }));
  expect(itemsFor("tool-interrupted", false)).toContainEqual(expect.objectContaining({ kind: "tool", status: "interrupted" }));
  expect(itemsFor("streaming-final", true)).toContainEqual(expect.objectContaining({ kind: "message", channel: "final", streaming: true }));
  expect(itemsFor("native-failed", false)).toContainEqual(expect.objectContaining({ kind: "protocol", surface: "run_terminal", runState: "failed" }));
});
it("keeps replies local and restores the saved conversation", async () => {
  render("?threadPreview=human-message");
  await act(async () => button("Send synthetic reply").click());
  expect(host.textContent).toContain("Please check timeouts.");
  expect(host.textContent).toContain("Preview reply received.");
  await act(async () => button("Show saved thread").click());
  expect(host.textContent).toContain("Saved conversation");
  expect(host.textContent).not.toContain("Preview reply received.");
  expect(network).not.toHaveBeenCalled();
});

it("plays one cumulative conversation, freezes on pause, settles and replays locally", async () => {
  vi.useFakeTimers();
  document.documentElement.style.setProperty("--motion-sandbox-stream-tick", "40ms");
  document.documentElement.style.setProperty("--motion-sandbox-playback-step", "4s");
  await act(async () => render("?threadPreview=all", true, "playback"));
  const playback = () => host.querySelector('[data-testid="conversation-playback"]')!;
  expect(playback().getAttribute("data-playback-state")).toBe("idle");
  expect(host.querySelectorAll('[data-testid="task-chat-human-bubble"]')).toHaveLength(0);
  expect(host.querySelector("#sandbox-thread-state")).toBeNull();
  await act(async () => button("Play conversation").click());
  expect(host.querySelectorAll('[data-testid="task-chat-human-bubble"]')).toHaveLength(1);
  await act(async () => vi.advanceTimersByTime(2500));
  expect(playback().getAttribute("data-playback-stage")).toBe("1");
  await act(async () => button("Pause").click());
  const paused = host.textContent;
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(host.textContent).toBe(paused);
  expect(playback().getAttribute("data-playback-state")).toBe("paused");
  await act(async () => button("Resume conversation").click());
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(playback().getAttribute("data-playback-state")).toBe("complete");
  expect(host.textContent).toContain("26 component source files");
  expect(host.querySelector('[data-testid="task-chat-bubble-attached-turn"]')).not.toBeNull();
  expect(host.querySelectorAll('[data-testid="task-chat-human-bubble"]')).toHaveLength(2);
  expect(host.querySelectorAll('[data-testid="task-chat-agent-bubble"]')).toHaveLength(2);
  expect(host.textContent).toContain("Verification complete");
  await act(async () => button("Replay conversation").click());
  expect(playback().getAttribute("data-playback-stage")).toBe("0");
  expect(host.querySelector('[data-testid="task-chat-agent-bubble"]')).toBeNull();
  await act(async () => button("Show saved thread").click());
  expect(host.textContent).toContain("Saved conversation");
  expect(host.querySelector('[data-testid="conversation-playback"]')).toBeNull();
  expect(network).not.toHaveBeenCalled();
});
it("shows the saved conversation for an unknown playback preview", () => {
  render("?threadPreview=unknown", true, "playback");
  expect(host.textContent).toContain("Saved conversation");
  expect(host.querySelector('[data-testid="conversation-playback"]')).toBeNull();
});
it("retains the saved conversation on ordinary tasks in playback mode", () => {
  render("", false, "playback");
  expect(host.textContent).toContain("Saved conversation");
  expect(host.querySelector('[data-testid="conversation-playback"]')).toBeNull();
});
