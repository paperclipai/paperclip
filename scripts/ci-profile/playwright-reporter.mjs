import { recorder, relativeFile } from "./record.mjs";

export default class CiProfileReporter {
  record = recorder("playwright");
  files = new Map();
  onBegin() { this.record({ kind: "start" }); }
  onTestEnd(test, result) {
    const file = relativeFile(test.location.file);
    const start = result.startTime.getTime();
    const end = start + result.duration;
    const parent = `${test.parent.project()?.name || ""}:${file}`;
    const previous = this.files.get(parent);
    this.files.set(parent, {
      kind: "file", id: parent, name: file, file,
      start: Math.min(previous?.start ?? start, start),
      end: Math.max(previous?.end ?? end, end),
      status: previous?.status === "failed" || ["failed", "timedOut"].includes(result.status)
        ? "failed" : "passed",
    });
    this.record({
      kind: "test", id: `${test.id}:${result.retry}`, parent,
      name: test.titlePath().slice(1).join(" > "), file,
      start, duration: result.duration, status: result.status, retries: result.retry,
    });
  }
  onEnd() {
    for (const { end, ...file } of this.files.values()) {
      this.record({ ...file, duration: end - file.start });
    }
    this.record({ kind: "end" });
  }
}
