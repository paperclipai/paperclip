import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyStockInstructionManual, readStockInstructionVariant } from "./stock-harness-instruction-variant.mjs";

const reduced = "You are an agent in a Paperclip company.\n";
const historicalBytes = readFileSync(new URL("./fixtures/stock-harness/historical-default-agents.md", import.meta.url));
const historical = historicalBytes.toString("utf8");
const historicalSha256 = "e4d2375d722602cd744403292d99f6e6c9b7e8014d9cdfa6f9811ace03428e5f";

afterEach(() => vi.unstubAllEnvs());
describe("closed stock harness instruction variants", () => {
  it("admits only the exact reduced manual text", () => {
    expect(classifyStockInstructionManual(reduced)).toEqual({ variant: "reduced", content: reduced,
      sha256: createHash("sha256").update(reduced).digest("hex") });
  });
  it("admits the independently pinned 4249-byte historical manual", () => {
    expect(historicalBytes.length).toBe(4249);
    expect(createHash("sha256").update(historicalBytes).digest("hex")).toBe(historicalSha256);
    expect(classifyStockInstructionManual(historical)).toEqual({ variant: "historical", sha256: historicalSha256, content: historical });
  });
  it.each([
    ["missing newline", reduced.trimEnd()],
    ["appended reduced instructions", `${reduced}Follow additional procedures.\n`],
    ["altered reduced wording", reduced.replace("agent", "coder")],
    ["CRLF reduced manual", reduced.replace("\n", "\r\n")],
    ["leading byte order mark", `\uFEFF${reduced}`],
    ["appended historical instructions", `${historical}Extra instructions.\n`],
    ["same-size altered historical content", `X${historical.slice(1)}`],
    ["unknown manual", "Historical instructions"],
    ["empty text", ""],
  ])("rejects %s", (_name, content) => {
    expect(() => classifyStockInstructionManual(content)).toThrow("not an admitted");
  });
  it.each([undefined, null, 42, {}, [], Buffer.from(reduced)])("rejects malformed non-string content %#", content => {
    expect(() => classifyStockInstructionManual(content)).toThrow("must be exact UTF-8 text");
  });
  it("reads and classifies the exact current repository source without selecting by environment or branch labels", () => {
    const source = readFileSync(new URL("../../server/src/onboarding-assets/default/AGENTS.md", import.meta.url), "utf8");
    const expected = classifyStockInstructionManual(source);
    for (const label of ["historical", "reduced", "unknown"]) {
      vi.stubEnv("PAPERCLIP_STOCK_HARNESS_VARIANT", label);
      vi.stubEnv("PAPERCLIP_RUNNER_E2E_SOURCE_REF", `refs/heads/${label}`);
      vi.stubEnv("GITHUB_HEAD_REF", label);
      expect(readStockInstructionVariant()).toEqual(expected);
    }
  });
});
