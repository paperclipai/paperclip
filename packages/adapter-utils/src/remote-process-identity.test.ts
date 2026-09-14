import { describe, expect, it } from "vitest";
import { isRemoteProcessIdentity, parseRemoteProcessLaunchReceipt } from "./remote-process-identity.js";

const nonce = "f3ea4111-4594-4525-a149-153bc79fcda4";
const bootId = "1d2c2412-544b-4f04-955e-c41256fe5866";
const line = `paperclip-process-v1|${nonce}|4321|1000|4321|${bootId}|123456\n`;
describe("remote pre-exec process receipts", () => {
  it("parses an exact attempt-bound kernel identity", () => {
    expect(parseRemoteProcessLaunchReceipt(line, nonce)).toEqual({ version: 1, pid: 4321, uid: 1000, processGroupId: 4321, bootId, startTicks: "123456" });
  });
  it.each([
    ["different launch", line.replace(nonce, bootId)],
    ["replayed response", line + line],
    ["diagnostic prefix", "Agent output\n" + line],
    ["diagnostic suffix", line + "Agent output\n"],
    ["PID one", line.replace("|4321|", "|1|")],
    ["unsafe PID", line.replace("|4321|", "|9007199254740992|")],
    ["unknown boot", line.replace(bootId, "unknown")],
    ["empty birth", line.replace("|123456", "|")],
    ["oversized birth", line.replace("|123456", "|" + "9".repeat(21))],
    ["unterminated response", line.trim()],
  ])("rejects %s", (_name, value) => { expect(parseRemoteProcessLaunchReceipt(value, nonce)).toBeNull(); });
  it("rejects extra or untyped metadata and does not treat an agent nonce as proof", () => {
    const identity = parseRemoteProcessLaunchReceipt(line, nonce)!;
    expect(isRemoteProcessIdentity({ ...identity, argv: "secret" })).toBe(false);
    expect(isRemoteProcessIdentity({ ...identity, pid: "4321" })).toBe(false);
    expect(parseRemoteProcessLaunchReceipt(line, "invalid")).toBeNull();
  });
});
