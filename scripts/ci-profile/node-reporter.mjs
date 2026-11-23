import path from "node:path";
import { recorder, relativeFile } from "./record.mjs";

export default async function* reporter(source) {
  const record = recorder("node");
  record({ kind: "start" });
  let index = 0;
  const files = new Map();
  for await (const event of source) {
    // complete is emitted as execution finishes; pass/fail are buffered in
    // declaration order and cannot be used to place parallel tests in time.
    if (event.type !== "test:complete") continue;
    const data = event.data;
    const duration = data.details?.duration_ms;
    if (!data.file || !Number.isFinite(duration)) continue;
    const file = relativeFile(data.file);
    const end = Date.now();
    const start = end - duration;
    const previous = files.get(file);
    files.set(file, {
      start: Math.min(previous?.start ?? start, start),
      end: Math.max(previous?.end ?? end, end),
      failed: previous?.failed || (!data.skip && !data.details.passed),
    });
    // File completion events may use the CLI's relative argument as their
    // name while data.file is absolute. They are containers, not test cases.
    if (path.resolve(data.name) === path.resolve(data.file) || data.details.type === "suite") continue;
    record({
      kind: "test", parent: file,
      id: String(index++), name: data.name, file, start, duration,
      status: data.skip ? "skipped" : data.details.passed ? "passed" : "failed",
      clock: "reporter-receipt",
    });
  }
  for (const [file, timing] of files) {
    record({ kind: "file", id: file, name: file, file,
      start: timing.start, duration: timing.end - timing.start,
      status: timing.failed ? "failed" : "passed", clock: "reporter-receipt" });
  }
  record({ kind: "end" });
}
