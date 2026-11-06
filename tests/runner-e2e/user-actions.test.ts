import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withBrowserEvent } from "./user-actions.js";

describe("browser event ownership", () => {
  it.each(["event-first", "action-first", "synchronous-action"])("handles both original failures when %s rejects", mode => {
    // A separate strict Node process makes a detached rejection an actual process
    // failure, matching a live launch rather than relying on a mocked listener.
    const script = `
      import assert from 'node:assert/strict';
      import { setTimeout as delay } from 'node:timers/promises';
      import { withBrowserEvent } from ${JSON.stringify(new URL("./user-actions.ts", import.meta.url).href)};
      const mode = ${JSON.stringify(mode)};
      const eventError = new Error('event_failure'), actionError = new Error('action_failure');
      let observed = 0, acted = 0;
      const event = () => { observed++; return delay(mode === 'event-first' ? 0 : 25).then(() => { throw eventError; }); };
      const action = () => {
        acted++;
        if (mode === 'synchronous-action') throw actionError;
        return delay(mode === 'action-first' ? 0 : 25).then(() => { throw actionError; });
      };
      await withBrowserEvent(event, action).then(() => assert.fail('must fail'), error => {
        assert.equal(error, mode === 'event-first' ? eventError : actionError);
      });
      await delay(60);
      assert.equal(observed, 1); assert.equal(acted, 1);
    `;
    const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--import",
      fileURLToPath(new URL("../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url)), "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
  it("settles a late initiating action before failure cleanup can start", async () => {
    const order: string[] = [], original = new Error("event_timeout");
    let actionStarted!: () => void, releaseAction!: () => void;
    const started = new Promise<void>(resolve => { actionStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseAction = resolve; });
    const completed = withBrowserEvent(async () => { await started; throw original; }, async () => {
      actionStarted();
      await held;
      order.push("late-mutation");
    }).catch(error => { order.push("cleanup"); return error; });
    await started;
    try {
      // Let the observation rejection propagate while the action is still held.
      await nextTurn();
      expect(order).toEqual([]);
    } finally { releaseAction(); }
    expect(await completed).toBe(original);
    expect(order).toEqual(["late-mutation", "cleanup"]);
  });
  it("returns the original event after its single initiating action completes", async () => {
    const order: string[] = [], response = { status: 201 };
    const result = await withBrowserEvent(async () => { order.push("observe"); return response; }, async () => { order.push("action"); });
    expect(result).toBe(response);
    expect(order).toEqual(["observe", "action"]);
  });
});
