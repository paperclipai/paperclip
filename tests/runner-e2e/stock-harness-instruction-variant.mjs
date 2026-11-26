import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const reduced = "You are an agent in a Paperclip company.\n";
const historicalSha256 = "e4d2375d722602cd744403292d99f6e6c9b7e8014d9cdfa6f9811ace03428e5f";

/**
 * @param {unknown} content
 * @returns {{ variant: 'reduced' | 'historical', sha256: string, content: string }}
 */
export function classifyStockInstructionManual(content) {
  if (typeof content !== "string") throw new Error("Stock harness instruction manual must be exact UTF-8 text.");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  if (content === reduced) return { variant: "reduced", sha256, content };
  if (Buffer.byteLength(content, "utf8") === 4249 && sha256 === historicalSha256)
    return { variant: "historical", sha256, content };
  throw new Error("Stock harness instruction manual is not an admitted reduced or historical source.");
}

export function readStockInstructionVariant() {
  return classifyStockInstructionManual(readFileSync(new URL(
    "../../server/src/onboarding-assets/default/AGENTS.md", import.meta.url,
  ), "utf8"));
}
