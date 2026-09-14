import { describe, expect, it, vi } from "vitest";
import { RemoteProcessReceiptStream, remoteOwnedProcessCommand } from "./remote-owned-process.js";

const nonce = "f3ea4111-4594-4525-a149-153bc79fcda4";
const other = "1d2c2412-544b-4f04-955e-c41256fe5866";
const header = `paperclip-process-v1|${nonce}|4321|1000|4321|${other}|123456\n`;
describe("remote owned process launch", () => {
  it("keeps command values as literal argv for both launch modes", () => {
    const args = ["spaces ' $() `literal`", "\n"];
    for (const detached of [false, true]) {
      const command = remoteOwnedProcessCommand({ nonce, command: "node", args, detached });
      expect(command.args.slice(-3)).toEqual(["node", ...args]);
      expect(command.args[1]).not.toContain(args[0]);
    }
    expect(() => remoteOwnedProcessCommand({ nonce: "bad; command", command: "node", args: [], detached: true })).toThrow("nonce");
  });
  it("accepts every possible header split and leaves later receipt-looking output untouched", async () => {
    for (let split = 0; split < header.length; split++) {
      const sink = vi.fn(async () => {});
      const parser = new RemoteProcessReceiptStream(nonce, sink);
      expect(await parser.consume(header.slice(0, split))).toBe("");
      expect(await parser.consume(header.slice(split) + "agent\n" + header)).toBe("agent\n" + header);
      expect(await parser.finish(header + "agent\n" + header)).toBe("agent\n" + header);
      expect(sink).toHaveBeenCalledTimes(1);
    }
  });
  it("does not release agent output until ownership has persisted", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sink = vi.fn(() => gate);
    const parser = new RemoteProcessReceiptStream(nonce, sink);
    const seen: string[] = [];
    const first = parser.consume(header + "one").then(value => { seen.push(value); });
    const second = parser.consume("two").then(value => { seen.push(value); });
    await Promise.resolve(); await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(1); expect(seen).toEqual([]);
    release(); await Promise.all([first, second]); expect(seen).toEqual(["one", "two"]);
  });
  it("latches persistence failures and never forwards later output", async () => {
    const failure = new Error("database unavailable");
    const sink = vi.fn(async () => { throw failure; });
    const parser = new RemoteProcessReceiptStream(nonce, sink);
    await expect(parser.consume(header + "agent")).rejects.toBe(failure);
    await expect(parser.consume("more")).rejects.toBe(failure);
    await expect(parser.finish(header + "agent")).rejects.toBe(failure);
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it("also latches a non-Error rejection", async () => {
    const sink = vi.fn(async () => { throw undefined; });
    const parser = new RemoteProcessReceiptStream(nonce, sink);
    await expect(parser.consume(header)).rejects.toBeUndefined();
    await expect(parser.consume("agent")).rejects.toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it.each(["diagnostic\n" + header, header.replace(nonce, other), "x".repeat(513), header.trimEnd(), ""])("rejects malformed or missing launch output", async value => {
    const sink = vi.fn(async () => {});
    await expect(new RemoteProcessReceiptStream(nonce, sink).finish(value)).rejects.toThrow("remote_process_ownership_unverified");
    expect(sink).not.toHaveBeenCalled();
  });
  it("recovers a partial streamed header from the complete final result", async () => {
    const sink = vi.fn(async () => {});
    const parser = new RemoteProcessReceiptStream(nonce, sink);
    expect(await parser.consume(header.slice(0, 50))).toBe("");
    expect(await parser.finish(header + "result")).toBe("result");
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it("rejects changed final receipts without replacing established ownership", async () => {
    const sink = vi.fn(async () => {});
    const parser = new RemoteProcessReceiptStream(nonce, sink);
    await parser.consume(header);
    await expect(parser.finish(header.replace("|4321|", "|5678|"))).rejects.toThrow("remote_process_ownership_unverified");
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
