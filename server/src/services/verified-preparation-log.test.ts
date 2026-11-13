import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasVerifiedPreparationLog } from "./verified-preparation-log.js";

const fixture = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./run-log-store.js", () => ({ getRunLogStore: () => ({ read: fixture.read }) }));

function source() {
  const companyId = randomUUID(), agentId = randomUUID(), id = randomUUID(), ts = new Date();
  const chunk = "[paperclip] Enabled run-scoped skills from issue mentions: fixture/status-report\n";
  const record = { ts: ts.toISOString(), attemptId: randomUUID(), stream: "stdout", chunk, seq: 1 };
  const content = JSON.stringify(record) + "\n";
  const run: Parameters<typeof hasVerifiedPreparationLog>[0] = { companyId, agentId, id,
    contextSnapshot: { skillSelectionSnapshot: true, skillVersions: { "fixture/status-report": randomUUID() } },
    logStore: "s3_segments", logRef: `${companyId}/${agentId}/${id}`, logBytes: Buffer.byteLength(content),
    logSha256: createHash("sha256").update(content).digest("hex"), logCompressed: false,
    stdoutExcerpt: chunk, stderrExcerpt: "", lastOutputAt: ts, lastOutputSeq: 1,
    lastOutputStream: "stdout", lastOutputBytes: Buffer.byteLength(content) };
  return { run, content, record };
}

describe("verified host preparation output", () => {
  beforeEach(() => { fixture.read.mockReset(); });
  it("verifies the complete canonical bytes against the persisted selection and output watermark", async () => {
    const f = source();
    fixture.read.mockResolvedValue({ content: f.content });
    expect(await hasVerifiedPreparationLog(f.run)).toBe(true);
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(fixture.read.mock.calls[0][1]).toMatchObject({ offset: 0 });
    expect(fixture.read.mock.calls[0][1].limitBytes).toBeLessThan(4096);
    expect(fixture.read.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it.each(["versioned", "unversioned"])("verifies mentioned skills when the saved selection also has %s configured skills", async kind => {
    const f = source();
    f.run.contextSnapshot!.skillVersions = { "fixture/configured-skill": kind === "versioned" ? randomUUID() : null,
      "fixture/status-report": randomUUID() };
    fixture.read.mockResolvedValue({ content: f.content });
    expect(await hasVerifiedPreparationLog(f.run)).toBe(true);
  });

  it.each(["missing_selection", "different_selection", "malformed_version", "foreign_log", "changed_hash",
    "truncated", "extra_record", "provider_output", "changed_timestamp", "extra_provenance", "larger_log",
    "other_stream", "changed_watermark", "missing_log"] as const)("keeps uncertain output held: %s", async state => {
    const f = source();
    let content = f.content;
    if (state === "missing_selection") f.run.contextSnapshot = null;
    if (state === "different_selection") f.run.contextSnapshot!.skillVersions = { "other/skill": randomUUID() };
    if (state === "malformed_version") f.run.contextSnapshot!.skillVersions = { "fixture/status-report": "unbound" };
    if (state === "foreign_log") f.run.logRef = `${randomUUID()}/${f.run.agentId}/${f.run.id}`;
    if (state === "changed_hash") f.run.logSha256 = "b".repeat(64);
    if (state === "larger_log") f.run.logBytes = 4096;
    if (state === "other_stream") f.run.lastOutputStream = "stderr";
    if (state === "changed_watermark") f.run.lastOutputSeq = 2;
    if (state === "extra_record") content += JSON.stringify({ ...f.record, chunk: "Provider performed a tool action", seq: 2 }) + "\n";
    if (state === "provider_output") { f.record.chunk = "Provider completed an action\n"; content = JSON.stringify(f.record) + "\n"; f.run.stdoutExcerpt = f.record.chunk; }
    if (state === "changed_timestamp") content = JSON.stringify({ ...f.record, ts: new Date(0).toISOString() }) + "\n";
    if (state === "extra_provenance") content = JSON.stringify({ ...f.record, sourceCursor: 1 }) + "\n";
    if (["extra_record", "provider_output", "changed_timestamp", "extra_provenance"].includes(state)) {
      f.run.logSha256 = createHash("sha256").update(content).digest("hex");
      f.run.logBytes = f.run.lastOutputBytes = Buffer.byteLength(content);
    }
    if (state === "missing_log") fixture.read.mockRejectedValue(new Error("Object log not found"));
    else fixture.read.mockResolvedValue({ content, ...(state === "truncated" ? { nextOffset: f.run.logBytes } : {}) });
    expect(await hasVerifiedPreparationLog(f.run)).toBe(false);
  });

  it("verifies a log made only of the host's workspace notices written before the adapter starts", async () => {
    const f = source();
    const issueId = randomUUID(), ts = f.run.lastOutputAt!;
    const chunks = [f.record.chunk,
      "[paperclip] Execution workspace reuse freshness action \"replace\" because execution workspace configuration changed: repo/base ref, environment.\n",
      `[paperclip] Skipping saved session resume for task "${issueId}" because effective run configuration changed: environment.\n`];
    const content = chunks.map((chunk, index) => JSON.stringify({ ...f.record, chunk, seq: index + 1, ts: ts.toISOString() }) + "\n").join("");
    Object.assign(f.run, { lastOutputSeq: 3, stdoutExcerpt: chunks.join(""), logBytes: Buffer.byteLength(content),
      lastOutputBytes: Buffer.byteLength(content), logSha256: createHash("sha256").update(content).digest("hex") });
    fixture.read.mockResolvedValue({ content });
    expect(await hasVerifiedPreparationLog(f.run)).toBe(true);
    const notices = chunks.slice(1);
    const withoutSkills = notices.map((chunk, index) => JSON.stringify({ ...f.record, chunk, seq: index + 1, ts: ts.toISOString() }) + "\n").join("");
    Object.assign(f.run, { contextSnapshot: null, lastOutputSeq: 2, stdoutExcerpt: notices.join(""), logBytes: Buffer.byteLength(withoutSkills),
      lastOutputBytes: Buffer.byteLength(withoutSkills), logSha256: createHash("sha256").update(withoutSkills).digest("hex") });
    fixture.read.mockResolvedValue({ content: withoutSkills });
    expect(await hasVerifiedPreparationLog(f.run)).toBe(true);
  });

  it("accepts two notices of the same attempt", async () => {
    const f = source();
    const notice = "[paperclip] Skipping saved session resume because effective run configuration changed: environment.\n";
    const content = [1, 2].map(seq => JSON.stringify({ ...f.record, chunk: notice, seq }) + "\n").join("");
    Object.assign(f.run, { lastOutputSeq: 2, stdoutExcerpt: notice + notice, logBytes: Buffer.byteLength(content),
      lastOutputBytes: Buffer.byteLength(content), logSha256: createHash("sha256").update(content).digest("hex") });
    fixture.read.mockResolvedValue({ content });
    expect(await hasVerifiedPreparationLog(f.run)).toBe(true);
  });

  it.each(["provider_line", "other_attempt", "skills_after_notice"] as const)("keeps a log with other output held: %s", async state => {
    const f = source();
    const notice = "[paperclip] Skipping saved session resume because effective run configuration changed: environment.\n";
    const records = [{ ...f.record, chunk: notice, seq: 1 }, { ...f.record, seq: 2 }];
    if (state !== "skills_after_notice") records[1]!.chunk = notice;
    if (state === "provider_line") records[1]!.chunk = "[paperclip] Provider wrote a file\n";
    if (state === "other_attempt") records[1]!.attemptId = randomUUID();
    const content = records.map(record => JSON.stringify(record) + "\n").join("");
    Object.assign(f.run, { lastOutputSeq: 2, stdoutExcerpt: records.map(record => record.chunk).join(""),
      logBytes: Buffer.byteLength(content), lastOutputBytes: Buffer.byteLength(content),
      logSha256: createHash("sha256").update(content).digest("hex") });
    fixture.read.mockResolvedValue({ content });
    expect(await hasVerifiedPreparationLog(f.run)).toBe(false);
  });

  it("cancels a slow read, fails closed, and leaves an unrelated recovery responsive", async () => {
    const slow = source(), fast = source();
    let signal: AbortSignal | undefined;
    fixture.read.mockImplementation((handle, options) => {
      if (handle.logRef === fast.run.logRef) return Promise.resolve({ content: fast.content });
      signal = options.signal;
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const pending = hasVerifiedPreparationLog(slow.run);
    const ready = hasVerifiedPreparationLog(fast.run);
    expect(await Promise.race([pending.then(() => "slow"), ready.then(() => "fast")])).toBe("fast");
    expect(await ready).toBe(true);
    expect(await pending).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });
});
