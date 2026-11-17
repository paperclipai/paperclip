import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { NATIVE_START_EVENT, NativeTrigger, runningRunIds, triggeredOutageWindow, nativeTriggerMarkdown, nativeTriggerMatches, nativeTriggerShortfall, type ArmedNativeFault, type NativeTriggerEvent, type NativeTriggerHooks } from "./native-trigger.js";
import type { FaultReceipt } from "./types.js";

function harness(options: { events?: Record<string, NativeTriggerEvent[]>; runs?: unknown[]; open?: boolean; canFire?: () => boolean } = {}) {
  const fired: ArmedNativeFault[] = [];
  const recorded: string[] = [];
  const events = options.events ?? {};
  const hooks: NativeTriggerHooks = {
    canFire: options.canFire ?? (() => true),
    isOpen: () => options.open ?? true,
    issueId: taskId => `issue-${taskId}`,
    runs: async () => options.runs ?? [{ runId: "run-1", status: "running" }],
    events: async (runId, afterSeq, limit) => (events[runId] ?? []).filter(event => event.seq > afterSeq).slice(0, limit),
    fire: async armed => { fired.push(armed); },
    record: kind => { recorded.push(kind); },
  };
  return { hooks, fired, recorded, events };
}

const iso = (ms: number) => new Date(ms).toISOString();
const armed = (armedAt: number): ArmedNativeFault => ({ taskId: "t01", kind: "K2", holdMs: 0, armedAt });

describe("--native-trigger parsing", () => {
  const base = ["--env", "local", "--adapters", "codex", "--workloads", "A1", "--faults", "K2"];

  it("takes a target with an optional delay", () => {
    const parsed = parseCommand([...base, "--native-trigger", "native-start+5"]);
    expect(parsed.mode === "wave" && parsed.options.nativeTrigger).toEqual({ target: "native-start", delayMs: 5_000 });
    const provider = parseCommand([...base, "--native-trigger", "provider-event"]);
    expect(provider.mode === "wave" && provider.options.nativeTrigger).toEqual({ target: "provider-event", delayMs: 0 });
  });

  it("rejects unknown targets, long delays and conflicting trigger options", () => {
    expect(() => parseCommand([...base, "--native-trigger", "boot"])).toThrow(/takes native-start or provider-event/);
    expect(() => parseCommand([...base, "--native-trigger", "native-start+601"])).toThrow(/0-600/);
    expect(() => parseCommand([...base, "--storage", "s3", "--storage-trigger", "run-log", "--native-trigger", "native-start"])).toThrow(/pick one/);
    expect(() => parseCommand([...base, "--workloads", "C1", "--triggers", "comment", "--native-trigger", "native-start"])).toThrow(/--triggers time/);
    expect(() => parseCommand([...base, "--workloads", "A1,G1", "--native-trigger", "native-start"])).toThrow(/board-acting workloads \(G1\)/);
  });

  it("starts an ST1 outage when the trigger fires only with s3 storage and no planned storage faults", () => {
    const parsed = parseCommand([...base, "--storage", "s3", "--native-trigger", "native-start+5", "--native-trigger-outage", "120"]);
    expect(parsed.mode === "wave" && parsed.options.nativeTrigger).toEqual({ target: "native-start", delayMs: 5_000, outageMs: 120_000 });
    expect(() => parseCommand([...base, "--storage", "s3", "--native-trigger-outage", "120"])).toThrow(/needs --native-trigger/);
    expect(() => parseCommand([...base, "--native-trigger", "native-start", "--native-trigger-outage", "120"])).toThrow(/needs --storage s3/);
    expect(() => parseCommand([...base, "--storage", "s3", "--storage-faults", "ST1", "--native-trigger", "native-start", "--native-trigger-outage", "120"])).toThrow(/drop --storage-faults/);
    expect(() => parseCommand([...base, "--storage", "s3", "--native-trigger", "native-start", "--native-trigger-outage", "5"])).toThrow(/10 to 900/);
    expect(triggeredOutageWindow(4_000, 120_000)).toEqual({ kind: "ST1", startMs: 4_000, durationMs: 120_000,
      rules: [{ fault: { kind: "outage", status: 503 } }] });
  });

  it("reads running run ids from the issue runs API shape", () => {
    expect(runningRunIds([{ runId: "a", status: "running" }, { runId: "b", status: "failed" }, { id: "c", status: "running" }, null])).toEqual(["a", "c"]);
    expect(runningRunIds(null)).toEqual([]);
  });

  it("matches native start and the first provider events only", () => {
    expect(nativeTriggerMatches("native-start", NATIVE_START_EVENT)).toBe(true);
    expect(nativeTriggerMatches("native-start", "native.process_identity_recorded")).toBe(false);
    expect(nativeTriggerMatches("provider-event", "session.started")).toBe(true);
    expect(nativeTriggerMatches("provider-event", "lifecycle")).toBe(false);
  });
});

describe("native-triggered restart", () => {
  it("fires the armed fault the delay after a native start that followed arming", async () => {
    const armedAt = 1_000_000;
    const h = harness({ events: { "run-1": [
      { seq: 1, eventType: NATIVE_START_EVENT, createdAt: iso(armedAt - 5_000) },
      { seq: 2, eventType: "lifecycle", createdAt: iso(armedAt + 1_000) },
      { seq: 3, eventType: NATIVE_START_EVENT, createdAt: iso(armedAt + 2_000) },
    ] } });
    const trigger = new NativeTrigger({ target: "native-start", delayMs: 4_000 }, h.hooks);
    trigger.arm(armed(armedAt));
    await trigger.tick(armedAt + 3_000);
    expect(h.fired).toEqual([]);
    expect(trigger.receipts[0]).toMatchObject({ seenAt: armedAt + 2_000, runId: "run-1", eventType: NATIVE_START_EVENT });
    await trigger.tick(armedAt + 6_000);
    expect(h.fired).toEqual([armed(armedAt)]);
    expect(trigger.receipts[0]!.firedAt).toBe(armedAt + 6_000);
    await trigger.tick(armedAt + 7_000);
    expect(h.fired).toHaveLength(1);
  });

  it("waits while another fault is in progress and only reads running runs", async () => {
    let free = false;
    const armedAt = 2_000_000;
    const h = harness({ canFire: () => free,
      runs: [{ runId: "old", status: "failed" }, { runId: "run-1", status: "running" }],
      events: { old: [{ seq: 1, eventType: NATIVE_START_EVENT, createdAt: iso(armedAt + 500) }],
        "run-1": [{ seq: 7, eventType: "session.started", createdAt: iso(armedAt + 1_000) }] } });
    const trigger = new NativeTrigger({ target: "provider-event", delayMs: 0 }, h.hooks);
    trigger.arm(armed(armedAt));
    await trigger.tick(armedAt + 2_000);
    expect(h.fired).toEqual([]);
    free = true;
    await trigger.tick(armedAt + 3_000);
    expect(h.fired).toHaveLength(1);
    expect(trigger.receipts[0]).toMatchObject({ runId: "run-1", eventType: "session.started" });
  });

  it("stays busy while a seen event waits out its delay and still fails a wave in which no restart fired", async () => {
    const armedAt = 4_000_000;
    let open = true;
    const h = harness({ events: { "run-1": [{ seq: 1, eventType: NATIVE_START_EVENT, createdAt: iso(armedAt + 10) }] } });
    h.hooks.isOpen = () => open;
    const trigger = new NativeTrigger({ target: "native-start", delayMs: 600_000 }, h.hooks);
    trigger.arm(armed(armedAt));
    expect(trigger.busy).toBe(false);
    await trigger.tick(armedAt + 1_000);
    expect(trigger.busy).toBe(true);
    open = false;
    await trigger.tick(armedAt + 2_000);
    expect(trigger.busy).toBe(false);
    const receipts = trigger.finish([]);
    expect(receipts[0]).toMatchObject({ missedReason: "task_rested_after_event", firedAt: null });
    expect(nativeTriggerShortfall(receipts)).toMatch(/1 saw the event, none fired/);
  });

  it("reads at most three event pages per run in one pass and resumes from its cursor", async () => {
    const armedAt = 5_000_000;
    const deltas = Array.from({ length: 700 }, (_, index) => ({ seq: index + 1, eventType: "item.delta", createdAt: iso(armedAt + 1) }));
    const h = harness({ events: { "run-1": [...deltas, { seq: 701, eventType: NATIVE_START_EVENT, createdAt: iso(armedAt + 2) }] } });
    let reads = 0;
    const events = h.hooks.events;
    h.hooks.events = async (...args) => { reads += 1; return events(...args); };
    const trigger = new NativeTrigger({ target: "native-start", delayMs: 0 }, h.hooks);
    trigger.arm(armed(armedAt));
    await trigger.tick(armedAt + 100);
    expect(reads).toBe(3);
    expect(h.fired).toEqual([]);
    await trigger.tick(armedAt + 200);
    expect(h.fired).toHaveLength(1);
    expect(trigger.receipts[0]).toMatchObject({ eventType: NATIVE_START_EVENT });
  });

  it("records a missed trigger when the task rests or no event arrives, and links fired faults", async () => {
    const resting = harness({ open: false });
    const rested = new NativeTrigger({ target: "native-start", delayMs: 0 }, resting.hooks);
    rested.arm(armed(1));
    await rested.tick(10);
    expect(rested.receipts[0]).toMatchObject({ missedReason: "task_rested", firedAt: null });
    expect(nativeTriggerShortfall(rested.finish([]))).toMatch(/none fired/);

    const quiet = new NativeTrigger({ target: "native-start", delayMs: 0 }, harness().hooks);
    quiet.arm(armed(1));
    await quiet.tick(10);
    expect(quiet.finish([])[0]).toMatchObject({ missedReason: "no_matching_event" });

    const armedAt = 3_000_000;
    const h = harness({ events: { "run-1": [{ seq: 1, eventType: NATIVE_START_EVENT, createdAt: iso(armedAt + 10) }] } });
    const trigger = new NativeTrigger({ target: "native-start", delayMs: 0 }, h.hooks);
    trigger.arm(armed(armedAt));
    await trigger.tick(armedAt + 100);
    const fault = { faultId: "f01", requestedBy: "t01", requestedAt: armedAt + 200 } as FaultReceipt;
    const receipts = trigger.finish([fault]);
    expect(receipts[0]!.faultId).toBe("f01");
    expect(nativeTriggerShortfall(receipts)).toBeNull();
    expect(nativeTriggerMarkdown(receipts)).toContain("| t01 | K2 | f01 | run-1 | native.process_start_requested | 0.1 s |");
  });
});
