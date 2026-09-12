import { constants } from "node:fs";
import fs from "node:fs/promises";

const MAX_INSTRUCTION_BYTES = 64 * 1024;

function oversizedInstructions(): Error {
  return new Error(
    "Grok inline instructions exceed the 64 KiB UTF-8 limit for --rules. Reduce the instruction file and keep larger reference material in separate files.",
  );
}

export async function readGrokInstructions(filePath: string): Promise<string> {
  // Follow managed symlinks, but validate and read the same opened target.
  // Nonblocking open lets us reject FIFOs without waiting for a writer.
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Grok instructions must resolve to a regular file.");
    if (stat.size > MAX_INSTRUCTION_BYTES) throw oversizedInstructions();

    // A stat-only limit races with appends. Read at most one byte beyond the
    // limit, even if the file grows after stat or read returns short chunks.
    const buffer = Buffer.alloc(MAX_INSTRUCTION_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_INSTRUCTION_BYTES) throw oversizedInstructions();
    const rules = buffer.subarray(0, offset).toString("utf8");
    // Keep the encoded-text limit when malformed input expands to UTF-8
    // replacement characters during decoding, matching fs.readFile's behaviour.
    if (Buffer.byteLength(rules, "utf8") > MAX_INSTRUCTION_BYTES) throw oversizedInstructions();
    return rules;
  } finally {
    await handle.close();
  }
}
