import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBrokenStdoutError, Timeline, timelineEchoBroken } from "./timeline.js";

describe("Timeline with a broken stdout", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  it("classifies broken-pipe errors only", () => {
    expect(isBrokenStdoutError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isBrokenStdoutError(Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" }))).toBe(true);
    expect(isBrokenStdoutError(new Error("other"))).toBe(false);
    expect(isBrokenStdoutError(null)).toBe(false);
  });

  it("keeps writing the file but stops echoing once stdout fails, so errors cannot feed back", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chaos-timeline-"));
    directories.push(directory);
    const file = path.join(directory, "timeline.jsonl");
    const timeline = new Timeline(file);
    const echo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const previousQuiet = process.env.RESTART_CHAOS_QUIET;
    delete process.env.RESTART_CHAOS_QUIET;
    try {
      timeline.add("before");
      expect(echo).toHaveBeenCalledTimes(1);
      process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      expect(timelineEchoBroken()).toBe(true);
      for (let index = 0; index < 5; index += 1) timeline.add("after", { index });
      expect(echo).toHaveBeenCalledTimes(1);
      const kinds = (await readFile(file, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds).toEqual(["before", "after", "harness_stdout_lost", "after", "after", "after", "after"]);
      expect(timeline.entries.find(entry => entry.kind === "harness_stdout_lost")).toMatchObject({ error: "EPIPE write EPIPE" });
    } finally {
      if (previousQuiet === undefined) delete process.env.RESTART_CHAOS_QUIET; else process.env.RESTART_CHAOS_QUIET = previousQuiet;
    }
  });
});
