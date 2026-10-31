import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { capturePaperclipWorkspace } from "../src/live/workspace-diff.ts";

const root = await mkdtemp(join(tmpdir(), "paperclip-snapshot-benchmark-"));
try {
  const bytes = randomBytes(8 * 1024);
  for (let directory = 0; directory < 40; directory += 1) {
    const path = join(root, `dir-${String(directory).padStart(2, "0")}`);
    await mkdir(path);
    for (let file = 0; file < 25; file += 1) {
      await writeFile(join(path, `file-${String(file).padStart(2, "0")}.bin`), bytes);
    }
  }
  for (let i = 0; i < 3; i += 1) await capturePaperclipWorkspace(root);
  const samples = [];
  for (let i = 0; i < 11; i += 1) {
    const start = performance.now();
    const snapshot = await capturePaperclipWorkspace(root);
    if (snapshot.size !== 1_000) throw new Error(`Expected 1,000 files, got ${snapshot.size}`);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[5];
  console.log(JSON.stringify({ files: 1_000, medianMs: median, samplesMs: samples }));
  console.log(`METRIC median_ms=${median.toFixed(3)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
