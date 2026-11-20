import { afterEach, expect, it, vi } from "vitest";
import { observeChatWait } from "./chat-wait.js";

afterEach(() => vi.useRealTimers());

it("keeps one provider attempt visible through a timed reconnect and clears its wait on output", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-18T12:00:00Z") });
  const publish = vi.fn();
  const wait = observeChatWait(publish);
  wait.stdout('{"type":"turn.started"}\n{"type":"err');
  wait.stdout('or","message":"Reconnecting... 2/5 (429)","retry_after_seconds":92}\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    phase: "run_activity", message: expect.stringContaining("2/5; retry at 2026-11-18T12:01:32.000Z"),
  }));
  await vi.advanceTimersByTimeAsync(91_000);
  expect(publish.mock.calls.at(-1)?.[0].lastEventAt.toISOString()).toBe("2026-11-18T12:00:00.000Z");
  wait.stdout('{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(publish.mock.calls.at(-1)?.[0].message).toBe("Receiving agent output");
  wait.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows a slow turn before any error and replaces the reason on a timeout", async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const wait = observeChatWait(publish);
  wait.stdout('{"type":"turn.started"}\n');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(publish.mock.calls.at(-1)?.[0].message).toBe("Waiting for the model to respond");
  wait.stdout('{"type":"error","message":"Reconnecting 2/5 (request timed out)"}\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(publish.mock.calls.at(-1)?.[0].message).toBe("Codex: model request timed out. Reconnecting 2/5");
  wait.stop();
});

it("keeps a fast reply free of wait notices and ignores quoted and oversized content", async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const wait = observeChatWait(publish);
  wait.stdout('{"type":"turn.started"}\n');
  wait.stdout("x".repeat(20_000));
  wait.stdout('{"type":"error","message":"Reconnecting 2/5"}\n');
  wait.stdout('{"type":"item.completed","item":{"text":"Reconnecting 2/5"}}\n{"type":"turn.completed"}\n');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(publish).not.toHaveBeenCalled();
  wait.stop();
});

it("preserves an explicit provider reset instant including its UTC offset", async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const wait = observeChatWait(publish);
  wait.stdout(JSON.stringify({
    type: "error",
    message: "Reconnecting 2/5 (429)",
    retry_at: "2026-11-18T15:02:31+03:00",
  }) + "\n");
  await vi.advanceTimersByTimeAsync(0);
  expect(publish.mock.calls.at(-1)?.[0].message).toContain("retry at 2026-11-18T12:02:31.000Z");
  wait.stop();
});
