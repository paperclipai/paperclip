import { describe, expect, it, vi } from "vitest";
import { createPluginStreamBus } from "../services/plugin-stream-bus.js";
import {
  envExecOutputChannel,
  withPluginExecOutputStream,
} from "../services/environment-runtime.js";

const PLUGIN_ID = "paperclipinc.kubernetes";
const COMPANY_ID = "acme";
const RUN_ID = "run-1";

describe("withPluginExecOutputStream", () => {
  it("forwards worker-emitted chunks to onOutput in order and unsubscribes after resolve", async () => {
    const streamBus = createPluginStreamBus();
    const channel = envExecOutputChannel(RUN_ID);
    const received: Array<[string, string]> = [];
    let sawStreamingFlag = false;

    const result = await withPluginExecOutputStream({
      streamBus,
      pluginId: PLUGIN_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      onOutput: (stream, text) => {
        received.push([stream, text]);
      },
      run: async (streaming) => {
        sawStreamingFlag = streaming;
        // Simulate the worker emitting chunks mid-call via the stream bus.
        streamBus.publish(PLUGIN_ID, channel, COMPANY_ID, { stream: "stdout", text: "a" });
        streamBus.publish(PLUGIN_ID, channel, COMPANY_ID, { stream: "stderr", text: "b" });
        streamBus.publish(PLUGIN_ID, channel, COMPANY_ID, { stream: "stdout", text: "c" });
        return { exitCode: 0, streamed: true };
      },
    });

    expect(sawStreamingFlag).toBe(true);
    expect(received).toEqual([
      ["stdout", "a"],
      ["stderr", "b"],
      ["stdout", "c"],
    ]);
    expect(result).toEqual({ exitCode: 0, streamed: true });

    // Subscription must be torn down: further publishes are NOT delivered.
    streamBus.publish(PLUGIN_ID, channel, COMPANY_ID, { stream: "stdout", text: "late" });
    expect(received).toEqual([
      ["stdout", "a"],
      ["stderr", "b"],
      ["stdout", "c"],
    ]);
  });

  it("unsubscribes even when run() rejects", async () => {
    const streamBus = createPluginStreamBus();
    const channel = envExecOutputChannel(RUN_ID);
    const received: Array<[string, string]> = [];

    await expect(
      withPluginExecOutputStream({
        streamBus,
        pluginId: PLUGIN_ID,
        companyId: COMPANY_ID,
        runId: RUN_ID,
        onOutput: (stream, text) => received.push([stream, text]),
        run: async () => {
          streamBus.publish(PLUGIN_ID, channel, COMPANY_ID, { stream: "stdout", text: "x" });
          throw new Error("rpc blew up");
        },
      }),
    ).rejects.toThrow("rpc blew up");

    expect(received).toEqual([["stdout", "x"]]);

    // No leak: a publish after rejection is not delivered.
    streamBus.publish(PLUGIN_ID, channel, COMPANY_ID, { stream: "stdout", text: "after" });
    expect(received).toEqual([["stdout", "x"]]);
  });

  it("skips streaming (runs with streaming=false) when runId is null", async () => {
    const streamBus = createPluginStreamBus();
    const subscribeSpy = vi.spyOn(streamBus, "subscribe");
    let streamingFlag: boolean | undefined;

    const result = await withPluginExecOutputStream({
      streamBus,
      pluginId: PLUGIN_ID,
      companyId: COMPANY_ID,
      runId: null,
      onOutput: () => {},
      run: async (streaming) => {
        streamingFlag = streaming;
        return "buffered";
      },
    });

    expect(streamingFlag).toBe(false);
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(result).toBe("buffered");
  });

  it("skips streaming when no stream bus is available (buffered fallback)", async () => {
    let streamingFlag: boolean | undefined;
    const result = await withPluginExecOutputStream({
      streamBus: undefined,
      pluginId: PLUGIN_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      onOutput: () => {},
      run: async (streaming) => {
        streamingFlag = streaming;
        return "buffered";
      },
    });
    expect(streamingFlag).toBe(false);
    expect(result).toBe("buffered");
  });

  it("scopes the subscription by companyId (ignores another company's emits)", async () => {
    const streamBus = createPluginStreamBus();
    const channel = envExecOutputChannel(RUN_ID);
    const received: Array<[string, string]> = [];

    await withPluginExecOutputStream({
      streamBus,
      pluginId: PLUGIN_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      onOutput: (stream, text) => received.push([stream, text]),
      run: async () => {
        // Emit for a DIFFERENT company on the same channel — must be ignored.
        streamBus.publish(PLUGIN_ID, channel, "other-co", { stream: "stdout", text: "nope" });
        streamBus.publish(PLUGIN_ID, channel, COMPANY_ID, { stream: "stdout", text: "yes" });
        return null;
      },
    });

    expect(received).toEqual([["stdout", "yes"]]);
  });
});
