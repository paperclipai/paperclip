import { describe, expect, it, vi } from "vitest";
import { createIssueReadTiming } from "./issue-read-timing.js";

const span = vi.hoisted(() => ({ setStatus: vi.fn(), end: vi.fn() }));
const startActiveSpan = vi.hoisted(() => vi.fn((_name, callback) => callback(span)));
vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { ERROR: 2 },
  trace: { getTracer: () => ({ startActiveSpan }) },
}));

describe("issue read timing", () => {
  it("records parallel phases and the full request without recording result content", async () => {
    const timing = createIssueReadTiming();
    let resolve!: (value: string) => void;
    const lookup = timing.time("lookup", () => new Promise<string>((done) => { resolve = done; }));
    expect(await timing.time("documents", async () => "private content")).toBe("private content");
    resolve("private identifier");
    await lookup;
    expect(timing.header()).toMatch(/^paperclip_issue;dur=\d+\.\d, issue_documents;dur=\d+\.\d, issue_lookup;dur=\d+\.\d$/);
    expect(startActiveSpan).toHaveBeenCalledWith("issue.read.lookup", expect.any(Function));
    expect(timing.header()).not.toContain("private");
  });

  it("ends failed spans and preserves the original error without exporting its text", async () => {
    vi.clearAllMocks();
    const timing = createIssueReadTiming();
    const error = new Error("private database detail");
    await expect(timing.time("workspace", async () => { throw error; })).rejects.toBe(error);
    expect(span.setStatus).toHaveBeenCalledExactlyOnceWith({ code: 2 });
    expect(span.end).toHaveBeenCalledOnce();
    expect(timing.header()).toContain("issue_workspace;dur=");
    expect(timing.header()).not.toContain(error.message);
  });
});
